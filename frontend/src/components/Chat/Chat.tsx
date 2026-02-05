import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import { 
  ArrowLeft, Send, FolderOpen, FileText, Loader2, LogOut, 
  MessageSquare, Plus, Clock, ExternalLink, ChevronLeft, ChevronRight, RefreshCw, X
} from 'lucide-react'
import { api } from '../../services/api'

interface Citation {
  file_name: string
  file_id?: string
  drive_file_id?: string
  mime_type?: string
  chunk_index?: number
}

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  citations?: Citation[]
  isStreaming?: boolean
}

interface Conversation {
  id: string
  title: string
  created_at: string
  updated_at: string
  messages?: Message[]
}

interface FolderFile {
  id: string
  name: string
  mime_type: string
}

interface Folder {
  id: string
  name: string
  status: string
  file_count: number
  index_mode?: 'gemini_files' | 'chroma' | null
  gemini_files?: FolderFile[]
}

interface ChatProps {
  user: { id: string; email: string; name: string } | null
  onLogout: () => void
}

function FilePreviewPanel({ file, onClose }: { file: Citation | null, onClose: () => void }) {
  if (!file) return null
  const fileId = file.drive_file_id || file.file_id
  
  return (
    <div className="w-[500px] bg-white border-l border-gray-200 flex flex-col h-full shadow-xl">
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 bg-gradient-to-r from-gray-50 to-white">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="p-2 bg-blue-100 rounded-lg">
            <FileText className="w-5 h-5 text-blue-600" />
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-gray-900 truncate">{file.file_name}</p>
            <p className="text-xs text-gray-500">Document Preview</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {fileId && (
            <a
              href={`https://drive.google.com/file/d/${fileId}/view`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
              Open
            </a>
          )}
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>
      <div className="flex-1 bg-gray-100">
        {fileId ? (
          <iframe
            src={`https://drive.google.com/file/d/${fileId}/preview`}
            className="w-full h-full border-0"
            title={file.file_name}
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center p-8">
              <div className="w-20 h-20 mx-auto mb-4 bg-gray-200 rounded-full flex items-center justify-center">
                <FileText className="w-10 h-10 text-gray-400" />
              </div>
              <p className="text-gray-600 font-medium">Preview not available</p>
              <p className="text-sm text-gray-400 mt-1">File ID not found</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export function Chat({ user, onLogout }: ChatProps) {
  const { folderId } = useParams<{ folderId: string }>()
  const navigate = useNavigate()
  const [folder, setFolder] = useState<Folder | null>(null)
  const [folderFiles, setFolderFiles] = useState<FolderFile[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [previewFile, setPreviewFile] = useState<Citation | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [reindexing, setReindexing] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (folderId) {
      api.getFolder(folderId).then((f) => {
        setFolder(f)
        if (f.gemini_files) setFolderFiles(f.gemini_files)
      }).catch(() => navigate('/'))
      api.getFolderFiles(folderId).then(setFolderFiles).catch(console.error)
      api.getConversations(folderId).then(setConversations).catch(console.error)
    }
  }, [folderId, navigate])

  useEffect(() => {
    if (folder?.status === 'pending' || folder?.status === 'indexing') {
      const interval = setInterval(() => {
        if (folderId) api.getFolder(folderId).then(setFolder).catch(console.error)
      }, 2000)
      return () => clearInterval(interval)
    }
  }, [folder?.status, folderId])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const startNewConversation = () => {
    setConversationId(null)
    setMessages([])
    setPreviewFile(null)
    setInput('')
    setTimeout(() => inputRef.current?.focus(), 100)
  }

  const loadConversation = async (convId: string) => {
    try {
      const conv = await api.getConversation(convId)
      setConversationId(convId)
      setMessages(conv.messages || [])
    } catch (err) {
      console.error('Failed to load conversation:', err)
    }
  }

  const handleReindex = async () => {
    if (!folderId || reindexing) return
    setReindexing(true)
    try {
      const updated = await api.reindexFolder(folderId)
      setFolder(updated)
      setMessages([])
      setConversationId(null)
    } catch (err) {
      console.error('Failed to reindex:', err)
    } finally {
      setReindexing(false)
    }
  }

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || !folderId || loading) return

    const userMessage: Message = { id: Date.now().toString(), role: 'user', content: input }
    setMessages((prev) => [...prev, userMessage])
    const messageText = input
    setInput('')
    setLoading(true)

    const streamingId = `streaming-${Date.now()}`
    setMessages((prev) => [...prev, { id: streamingId, role: 'assistant', content: '', isStreaming: true }])

    abortControllerRef.current = api.sendMessageStream(
      folderId,
      messageText,
      conversationId || undefined,
      (text) => {
        setMessages((prev) => prev.map((m) => m.id === streamingId ? { ...m, content: m.content + text } : m))
      },
      (convId) => {
        setConversationId(convId)
        api.getConversations(folderId).then(setConversations).catch(console.error)
      },
      (messageId, citations) => {
        setMessages((prev) => prev.map((m) => {
          if (m.id !== streamingId) return m
          const cleanContent = m.content.replace(/\[Source:\s*[^\]]+\]/gi, '').trim()
          return { ...m, id: messageId, content: cleanContent, citations: citations || undefined, isStreaming: false }
        }))
        setLoading(false)
      },
      (error) => {
        console.error('Stream error:', error)
        setMessages((prev) => prev.map((m) => m.id === streamingId ? { ...m, content: 'Something went wrong.', isStreaming: false } : m))
        setLoading(false)
      }
    )
  }

  useEffect(() => { return () => { abortControllerRef.current?.abort() } }, [])

  const formatDate = (dateStr: string) => {
    if (!dateStr) return ''
    try {
      const date = new Date(dateStr)
      if (isNaN(date.getTime())) return ''
      const diffMs = Date.now() - date.getTime()
      const diffMins = Math.floor(diffMs / 60000)
      if (diffMins < 1) return 'Just now'
      if (diffMins < 60) return `${diffMins}m ago`
      if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`
      return `${Math.floor(diffMins / 1440)}d ago`
    } catch { return '' }
  }

  return (
    <div className="h-screen bg-gradient-to-br from-slate-50 to-gray-100 flex">
      <div className={`bg-white border-r border-gray-100 flex flex-col transition-all duration-300 ${sidebarCollapsed ? 'w-0 overflow-hidden' : 'w-72'}`}>
        <div className="p-3 flex items-center justify-between border-b border-gray-100">
          <button onClick={startNewConversation} className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors">
            <Plus className="w-4 h-4" /> New
          </button>
          <button onClick={() => setSidebarCollapsed(true)} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">
            <ChevronLeft className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {conversations.length === 0 ? (
            <div className="text-center py-10 px-4">
              <MessageSquare className="w-8 h-8 mx-auto mb-2 text-gray-300" />
              <p className="text-sm text-gray-400">No conversations</p>
            </div>
          ) : (
            <div className="py-1">
              {conversations.map((conv) => (
                <button
                  key={conv.id}
                  onClick={() => loadConversation(conv.id)}
                  className={`w-full text-left px-3 py-2.5 mx-1 my-0.5 rounded-lg transition-colors ${conversationId === conv.id ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-50 text-gray-700'}`}
                  style={{ width: 'calc(100% - 8px)' }}
                >
                  <p className="text-sm font-medium truncate">{conv.title || 'New Conversation'}</p>
                  {formatDate(conv.updated_at) && (
                    <p className="text-xs text-gray-400 mt-0.5">{formatDate(conv.updated_at)}</p>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {sidebarCollapsed && (
        <button onClick={() => setSidebarCollapsed(false)} className="absolute left-0 top-20 z-10 bg-white border border-gray-200 border-l-0 rounded-r-xl px-2 py-3 shadow-md hover:bg-blue-50 hover:border-blue-200 transition-all group">
          <ChevronRight className="w-5 h-5 text-gray-500 group-hover:text-blue-600" />
        </button>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-white/80 backdrop-blur-sm border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button onClick={() => navigate('/')} className="p-2.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-xl transition-colors">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-4">
              <div className="bg-gradient-to-br from-blue-500 to-blue-600 p-3 rounded-xl shadow-lg shadow-blue-500/20">
                <FolderOpen className="w-6 h-6 text-white" />
              </div>
              <div>
                <h1 className="font-bold text-lg text-gray-900">{folder?.name || 'Loading...'}</h1>
                <div className="flex items-center gap-3 mt-0.5">
                  <p className="text-sm text-gray-500">
                    {folder?.status === 'pending' || folder?.status === 'indexing' ? (
                      <span className="flex items-center gap-1.5">
                        <Loader2 className="w-3 h-3 animate-spin" /> Indexing files...
                      </span>
                    ) : (
                      `${folder?.file_count} file${folder?.file_count !== 1 ? 's' : ''}`
                    )}
                  </p>
                  {folder?.status === 'ready' && folder?.file_count === 0 && (
                    <button onClick={handleReindex} disabled={reindexing} className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium bg-amber-100 text-amber-700 rounded-full hover:bg-amber-200 transition-colors">
                      <RefreshCw className={`w-3 h-3 ${reindexing ? 'animate-spin' : ''}`} /> Re-index
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-600 font-medium">{user?.email}</span>
            <button onClick={onLogout} className="p-2.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-xl transition-colors">
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">
          <div className="max-w-4xl mx-auto px-6 py-8">
            {messages.length === 0 && (
              <div className="flex items-center justify-center h-[60vh]">
                <div className="text-center">
                  <div className="bg-gradient-to-br from-blue-100 to-indigo-100 rounded-3xl p-8 w-fit mx-auto mb-8">
                    <FolderOpen className="w-16 h-16 text-blue-600" />
                  </div>
                  <h2 className="text-2xl font-bold text-gray-800 mb-3">Ask anything about your files</h2>
                  <p className="text-gray-500 max-w-md mx-auto">I can help you find information, summarize documents, and answer questions about the files in this folder.</p>
                </div>
              </div>
            )}
            <div className="space-y-6">
              {messages.map((message) => (
                <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] ${message.role === 'user' ? 'bg-gradient-to-r from-blue-600 to-blue-700 text-white rounded-2xl rounded-br-sm px-5 py-3 shadow-lg shadow-blue-500/20' : 'bg-white border border-gray-200 rounded-2xl rounded-bl-sm px-6 py-5 shadow-sm'}`}>
                    <div className={message.role === 'assistant' ? 'prose prose-sm max-w-none text-gray-800' : ''}>
                      {message.isStreaming ? (
                        message.content ? (
                          <ReactMarkdown>{message.content}</ReactMarkdown>
                        ) : (
                          <div className="flex items-center gap-2 text-gray-400">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span>Thinking...</span>
                          </div>
                        )
                      ) : message.role === 'assistant' ? (
                        <ReactMarkdown>{message.content}</ReactMarkdown>
                      ) : (
                        <p>{message.content}</p>
                      )}
                    </div>
                    {!message.isStreaming && message.citations && message.citations.length > 0 && (
                      <div className="mt-5 pt-4 border-t border-gray-100">
                        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Sources</p>
                        <div className="flex flex-wrap gap-2">
                          {message.citations.map((c, i) => (
                            <button key={i} onClick={() => setPreviewFile(c)} className="group inline-flex items-center gap-2 bg-gradient-to-r from-gray-50 to-gray-100 hover:from-blue-50 hover:to-blue-100 border border-gray-200 hover:border-blue-300 text-gray-700 hover:text-blue-700 px-4 py-2 rounded-xl text-sm font-medium transition-all shadow-sm hover:shadow">
                              <FileText className="w-4 h-4 text-gray-400 group-hover:text-blue-500" />
                              <span className="truncate max-w-[180px]">{c.file_name}</span>
                              <ExternalLink className="w-3.5 h-3.5 opacity-40 group-hover:opacity-100" />
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div ref={messagesEndRef} />
          </div>
        </main>

        <div className="bg-white/80 backdrop-blur-sm border-t border-gray-200 p-5">
          <form onSubmit={handleSend} className="max-w-4xl mx-auto flex gap-3">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about your files..."
              className="flex-1 px-5 py-4 bg-white border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent shadow-sm text-gray-800 placeholder-gray-400"
              disabled={loading}
            />
            <button type="submit" disabled={loading || !input.trim()} className="bg-gradient-to-r from-blue-600 to-blue-700 text-white px-6 py-4 rounded-xl hover:from-blue-700 hover:to-blue-800 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-blue-500/25 transition-all">
              <Send className="w-5 h-5" />
            </button>
          </form>
        </div>
      </div>

      {previewFile && <FilePreviewPanel file={previewFile} onClose={() => setPreviewFile(null)} />}
    </div>
  )
}
