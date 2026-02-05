from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse
import uuid
import json
import asyncio

from app.db.database import get_db
from app.db.models import User, Folder, Conversation, Message, MessageRole, FolderStatus
from app.api.dependencies import get_current_user
from app.agent.hybrid_agent import HybridAgent

router = APIRouter()


class ChatRequest(BaseModel):
    folder_id: str
    message: str
    conversation_id: str | None = None


class MessageResponse(BaseModel):
    id: str
    role: str
    content: str
    citations: list | None = None

    class Config:
        from_attributes = True


class ConversationResponse(BaseModel):
    id: str
    title: str
    folder_id: str
    created_at: str
    updated_at: str
    messages: list[MessageResponse]

    class Config:
        from_attributes = True


@router.post("/send")
async def send_message(
    request: ChatRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Folder).where(Folder.id == uuid.UUID(request.folder_id), Folder.user_id == user.id)
    )
    folder = result.scalar_one_or_none()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    
    if folder.status != FolderStatus.READY:
        raise HTTPException(status_code=400, detail=f"Folder is not ready. Status: {folder.status.value}")
    
    if request.conversation_id:
        result = await db.execute(
            select(Conversation).where(
                Conversation.id == uuid.UUID(request.conversation_id),
                Conversation.user_id == user.id,
            )
        )
        conversation = result.scalar_one_or_none()
        if not conversation:
            raise HTTPException(status_code=404, detail="Conversation not found")
    else:
        title = request.message[:50] + "..." if len(request.message) > 50 else request.message
        conversation = Conversation(user_id=user.id, folder_id=folder.id, title=title)
        db.add(conversation)
        await db.commit()
        await db.refresh(conversation)
    
    user_message = Message(
        conversation_id=conversation.id,
        role=MessageRole.USER,
        content=request.message,
    )
    db.add(user_message)
    await db.commit()
    
    # Get conversation history for context
    msg_result = await db.execute(
        select(Message).where(Message.conversation_id == conversation.id).order_by(Message.created_at)
    )
    messages = msg_result.scalars().all()
    history = [{"role": m.role.value, "content": m.content} for m in messages[:-1]]  # Exclude the just-added user message
    
    # Use HybridAgent - routes to Gemini Files or Chroma based on folder's index_mode
    index_mode = folder.index_mode.value if folder.index_mode else "chroma"
    gemini_files = folder.gemini_files if folder.gemini_files else []
    
    agent = HybridAgent(
        folder_id=str(folder.id),
        user_id=str(user.id),
        index_mode=index_mode,
        gemini_files=gemini_files,
    )
    response = await agent.chat(request.message, history=history if history else None)
    
    assistant_message = Message(
        conversation_id=conversation.id,
        role=MessageRole.ASSISTANT,
        content=response["content"],
        citations=response.get("citations"),
    )
    db.add(assistant_message)
    await db.commit()
    await db.refresh(assistant_message)
    
    return {
        "conversation_id": str(conversation.id),
        "message": MessageResponse(
            id=str(assistant_message.id),
            role=assistant_message.role.value,
            content=assistant_message.content,
            citations=assistant_message.citations,
        ),
    }


@router.post("/send/stream")
async def send_message_stream(
    request: ChatRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Stream chat response using Server-Sent Events (SSE)."""
    result = await db.execute(
        select(Folder).where(Folder.id == uuid.UUID(request.folder_id), Folder.user_id == user.id)
    )
    folder = result.scalar_one_or_none()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    
    if folder.status != FolderStatus.READY:
        raise HTTPException(status_code=400, detail=f"Folder is not ready. Status: {folder.status.value}")
    
    if request.conversation_id:
        result = await db.execute(
            select(Conversation).where(
                Conversation.id == uuid.UUID(request.conversation_id),
                Conversation.user_id == user.id,
            )
        )
        conversation = result.scalar_one_or_none()
        if not conversation:
            raise HTTPException(status_code=404, detail="Conversation not found")
    else:
        title = request.message[:50] + "..." if len(request.message) > 50 else request.message
        conversation = Conversation(user_id=user.id, folder_id=folder.id, title=title)
        db.add(conversation)
        await db.commit()
        await db.refresh(conversation)
    
    user_message = Message(
        conversation_id=conversation.id,
        role=MessageRole.USER,
        content=request.message,
    )
    db.add(user_message)
    await db.commit()
    
    # Get conversation history
    msg_result = await db.execute(
        select(Message).where(Message.conversation_id == conversation.id).order_by(Message.created_at)
    )
    messages = msg_result.scalars().all()
    history = [{"role": m.role.value, "content": m.content} for m in messages[:-1]]
    
    index_mode = folder.index_mode.value if folder.index_mode else "chroma"
    gemini_files = folder.gemini_files if folder.gemini_files else []
    
    agent = HybridAgent(
        folder_id=str(folder.id),
        user_id=str(user.id),
        index_mode=index_mode,
        gemini_files=gemini_files,
    )
    
    async def event_generator():
        full_content = ""
        try:
            yield {
                "event": "start",
                "data": json.dumps({"conversation_id": str(conversation.id)})
            }
            
            async for chunk in agent.stream_chat(request.message, history=history if history else None):
                full_content += chunk
                yield {
                    "event": "content",
                    "data": json.dumps({"text": chunk})
                }
            
            citations = []
            if gemini_files:
                for f in gemini_files:
                    fname = f.get("name", "")
                    if fname:
                        citations.append({
                            "file_name": fname,
                            "file_id": f.get("id"),
                            "drive_file_id": f.get("id"),
                            "mime_type": f.get("mime_type", ""),
                        })
            
            async with db.begin():
                assistant_message = Message(
                    conversation_id=conversation.id,
                    role=MessageRole.ASSISTANT,
                    content=full_content,
                    citations=citations if citations else None,
                )
                db.add(assistant_message)
            
            yield {
                "event": "done",
                "data": json.dumps({
                    "message_id": str(assistant_message.id),
                    "citations": citations if citations else None,
                })
            }
            
        except Exception as e:
            yield {
                "event": "error",
                "data": json.dumps({"error": str(e)})
            }
    
    return EventSourceResponse(event_generator())


@router.get("/conversations", response_model=list[ConversationResponse])
async def list_conversations(
    folder_id: str | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    query = select(Conversation).where(Conversation.user_id == user.id).order_by(Conversation.updated_at.desc())
    if folder_id:
        query = query.where(Conversation.folder_id == uuid.UUID(folder_id))
    
    result = await db.execute(query)
    conversations = result.scalars().all()
    
    response = []
    for conv in conversations:
        msg_result = await db.execute(
            select(Message).where(Message.conversation_id == conv.id).order_by(Message.created_at)
        )
        messages = msg_result.scalars().all()
        response.append(
            ConversationResponse(
                id=str(conv.id),
                title=conv.title,
                folder_id=str(conv.folder_id),
                created_at=conv.created_at.isoformat(),
                updated_at=conv.updated_at.isoformat(),
                messages=[
                    MessageResponse(
                        id=str(m.id),
                        role=m.role.value,
                        content=m.content,
                        citations=m.citations,
                    )
                    for m in messages
                ],
            )
        )
    
    return response


@router.get("/conversations/{conversation_id}", response_model=ConversationResponse)
async def get_conversation(
    conversation_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Conversation).where(
            Conversation.id == uuid.UUID(conversation_id),
            Conversation.user_id == user.id,
        )
    )
    conversation = result.scalar_one_or_none()
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")
    
    msg_result = await db.execute(
        select(Message).where(Message.conversation_id == conversation.id).order_by(Message.created_at)
    )
    messages = msg_result.scalars().all()
    
    return ConversationResponse(
        id=str(conversation.id),
        title=conversation.title,
        folder_id=str(conversation.folder_id),
        created_at=conversation.created_at.isoformat(),
        updated_at=conversation.updated_at.isoformat(),
        messages=[
            MessageResponse(
                id=str(m.id),
                role=m.role.value,
                content=m.content,
                citations=m.citations,
            )
            for m in messages
        ],
    )
