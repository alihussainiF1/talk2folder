"""
Hybrid Agent - Routes between Gemini Files API (fast path) and ChromaDB (RAG path).

This replaces the ADK-based agent with direct Gemini API calls for:
- Lower latency (no extra network hop to ADK service)
- Streaming support
- Better control over the conversation flow
"""

import asyncio
import json
from typing import AsyncIterator
from concurrent.futures import ThreadPoolExecutor

import google.generativeai as genai
from google.generativeai.types import HarmCategory, HarmBlockThreshold

from app.config import get_settings
from app.services import vector_store
from app.services.gemini_service import (
    chat_with_files,
    stream_chat_with_files,
)

settings = get_settings()
genai.configure(api_key=settings.google_api_key)

_executor = ThreadPoolExecutor(max_workers=4)


RAG_SYSTEM_PROMPT = """You are a helpful assistant that answers questions about documents stored in a folder.

You have access to the following tools (call them by outputting JSON):
1. list_files - Lists all files in the folder
2. search_documents(query, n_results=10, file_name=None) - Semantic search across documents
3. get_file_content(file_name) - Gets all content from a specific file

CRITICAL RULES:
1. ALWAYS start by calling list_files to see what's available
2. If user asks about specific content, use search_documents with a good query
3. Base answers ONLY on retrieved documents
4. ALWAYS cite sources: [Source: filename]
5. If information not found, say "I couldn't find this in the provided documents"

OUTPUT FORMAT: For tool calls, output JSON like:
{"tool": "list_files"}
{"tool": "search_documents", "query": "...", "n_results": 10}
{"tool": "get_file_content", "file_name": "..."}

After getting results, provide your final answer with citations."""


class HybridAgent:
    """Agent that routes between Gemini Files and ChromaDB based on folder's index_mode."""
    
    def __init__(self, folder_id: str, user_id: str, index_mode: str, gemini_files: list[dict] | None = None):
        self.folder_id = folder_id
        self.user_id = user_id
        self.index_mode = index_mode
        self.gemini_files = gemini_files or []
        
        self.model = genai.GenerativeModel(
            "gemini-3-flash-preview",
            safety_settings={
                HarmCategory.HARM_CATEGORY_HARASSMENT: HarmBlockThreshold.BLOCK_NONE,
                HarmCategory.HARM_CATEGORY_HATE_SPEECH: HarmBlockThreshold.BLOCK_NONE,
                HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT: HarmBlockThreshold.BLOCK_NONE,
                HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT: HarmBlockThreshold.BLOCK_NONE,
            },
        )
    
    async def chat(self, message: str, history: list[dict] | None = None) -> dict:
        """
        Send a message and get a response.
        
        Routes to Gemini Files API or ChromaDB RAG based on index_mode.
        """
        if self.index_mode == "gemini_files":
            return await self._chat_gemini_files(message, history)
        else:
            return await self._chat_chroma_rag(message, history)
    
    async def stream_chat(self, message: str, history: list[dict] | None = None) -> AsyncIterator[str]:
        """
        Stream a chat response.
        """
        if self.index_mode == "gemini_files":
            async for chunk in self._stream_gemini_files(message, history):
                yield chunk
        else:
            async for chunk in self._stream_chroma_rag(message, history):
                yield chunk
    
    # ========== Gemini Files Mode ==========
    
    async def _chat_gemini_files(self, message: str, history: list[dict] | None) -> dict:
        """Chat using Gemini Files API (fast path)."""
        return await chat_with_files(message, self.gemini_files, history)
    
    async def _stream_gemini_files(self, message: str, history: list[dict] | None) -> AsyncIterator[str]:
        """Stream chat using Gemini Files API."""
        async for chunk in stream_chat_with_files(message, self.gemini_files, history):
            yield chunk
    
    # ========== ChromaDB RAG Mode ==========
    
    def _execute_tool(self, tool_call: dict) -> dict:
        """Execute a tool call against ChromaDB."""
        tool_name = tool_call.get("tool")
        
        if tool_name == "list_files":
            manifest = vector_store.get_file_manifest(self.user_id, self.folder_id)
            return {
                "files": [{"name": f["name"], "path": f.get("path", f["name"]), "type": f.get("mime_type", "")} for f in manifest],
                "total": len(manifest),
            }
        
        elif tool_name == "search_documents":
            query = tool_call.get("query", "")
            n_results = min(tool_call.get("n_results", 10), 20)
            file_name = tool_call.get("file_name")
            
            results = vector_store.search_documents(
                self.user_id, self.folder_id, query, n_results, file_name
            )
            return {
                "results": [
                    {
                        "content": r["content"],
                        "file_name": r["metadata"].get("file_name", "unknown"),
                        "file_id": r["metadata"].get("file_id", ""),
                        "file_path": r["metadata"].get("file_path", ""),
                        "mime_type": r["metadata"].get("mime_type", ""),
                        "chunk_index": r["metadata"].get("chunk_index", 0),
                        "page_number": r["metadata"].get("page_number"),
                    }
                    for r in results
                ],
                "total_found": len(results),
            }
        
        elif tool_name == "get_file_content":
            file_name = tool_call.get("file_name", "")
            # Get all chunks for this file via search
            results = vector_store.search_documents(
                self.user_id, self.folder_id, f"content from {file_name}", 50, file_name
            )
            return {
                "file_name": file_name,
                "chunks": [
                    {
                        "content": r["content"],
                        "chunk_index": r["metadata"].get("chunk_index", 0),
                        "page_number": r["metadata"].get("page_number"),
                    }
                    for r in results
                ],
                "total_chunks": len(results),
            }
        
        return {"error": f"Unknown tool: {tool_name}"}
    
    def _parse_tool_call(self, text: str) -> dict | None:
        """Try to parse a tool call from text."""
        # Look for JSON object
        import re
        json_match = re.search(r'\{[^{}]+\}', text)
        if json_match:
            try:
                obj = json.loads(json_match.group())
                if "tool" in obj:
                    return obj
            except json.JSONDecodeError:
                pass
        return None
    
    async def _chat_chroma_rag(self, message: str, history: list[dict] | None) -> dict:
        """Chat using ChromaDB RAG (for larger folders)."""
        loop = asyncio.get_running_loop()
        
        # Build conversation with system prompt
        messages = [{"role": "user", "parts": [RAG_SYSTEM_PROMPT + "\n\nUser: " + message]}]
        
        if history:
            # Add history
            for msg in history:
                role = "user" if msg["role"] == "user" else "model"
                messages.append({"role": role, "parts": [msg["content"]]})
        
        all_citations = []
        max_iterations = 5
        
        for _ in range(max_iterations):
            def _generate():
                chat = self.model.start_chat(history=messages[:-1] if len(messages) > 1 else [])
                return chat.send_message(messages[-1]["parts"]).text
            
            response_text = await loop.run_in_executor(_executor, _generate)
            
            # Check if it's a tool call
            tool_call = self._parse_tool_call(response_text)
            if tool_call:
                # Execute the tool
                tool_result = self._execute_tool(tool_call)
                
                if "results" in tool_result:
                    for r in tool_result["results"]:
                        citation = {
                            "file_name": r.get("file_name"),
                            "file_id": r.get("file_id"),
                            "drive_file_id": r.get("file_id"),
                            "chunk_index": r.get("chunk_index", 0),
                            "page_number": r.get("page_number"),
                            "mime_type": r.get("mime_type", ""),
                        }
                        if not any(c.get("file_name") == citation["file_name"] for c in all_citations):
                            all_citations.append(citation)
                
                # Add tool call and result to conversation
                messages.append({"role": "model", "parts": [response_text]})
                messages.append({"role": "user", "parts": [f"Tool result: {json.dumps(tool_result)}"]})
            else:
                # Final response
                return {
                    "content": response_text,
                    "citations": all_citations if all_citations else None,
                }
        
        # Max iterations reached
        return {
            "content": "I apologize, but I wasn't able to find the relevant information after several attempts.",
            "citations": all_citations if all_citations else None,
        }
    
    async def _stream_chroma_rag(self, message: str, history: list[dict] | None) -> AsyncIterator[str]:
        """Stream chat using ChromaDB RAG."""
        # For RAG mode with tools, we first do tool calls (non-streaming),
        # then stream the final response
        loop = asyncio.get_running_loop()
        
        messages = [{"role": "user", "parts": [RAG_SYSTEM_PROMPT + "\n\nUser: " + message]}]
        
        if history:
            for msg in history:
                role = "user" if msg["role"] == "user" else "model"
                messages.append({"role": role, "parts": [msg["content"]]})
        
        tool_context = []
        max_iterations = 5
        
        # First, do tool calls (non-streaming)
        for _ in range(max_iterations):
            def _generate():
                chat = self.model.start_chat(history=messages[:-1] if len(messages) > 1 else [])
                return chat.send_message(messages[-1]["parts"]).text
            
            response_text = await loop.run_in_executor(_executor, _generate)
            
            tool_call = self._parse_tool_call(response_text)
            if tool_call:
                tool_result = self._execute_tool(tool_call)
                tool_context.append({"call": tool_call, "result": tool_result})
                messages.append({"role": "model", "parts": [response_text]})
                messages.append({"role": "user", "parts": [f"Tool result: {json.dumps(tool_result)}"]})
            else:
                # Final response - stream it
                break
        
        # Now stream the final response
        import queue
        import threading
        
        q = queue.Queue()
        
        def _stream_final():
            try:
                final_prompt = "Now provide your final comprehensive answer based on the tool results. Include [Source: filename] citations."
                messages.append({"role": "user", "parts": [final_prompt]})
                
                chat = self.model.start_chat(history=messages[:-1] if len(messages) > 1 else [])
                response = chat.send_message(messages[-1]["parts"], stream=True)
                
                for chunk in response:
                    if chunk.text:
                        q.put(("text", chunk.text))
                q.put(("done", None))
            except Exception as e:
                q.put(("error", str(e)))
        
        thread = threading.Thread(target=_stream_final)
        thread.start()
        
        while True:
            try:
                item = await loop.run_in_executor(None, lambda: q.get(timeout=0.1))
                event_type, data = item
                if event_type == "done":
                    break
                elif event_type == "error":
                    yield f"\n\nError: {data}"
                    break
                elif event_type == "text":
                    yield data
            except:
                if not thread.is_alive():
                    break
                await asyncio.sleep(0.01)
        
        thread.join()
