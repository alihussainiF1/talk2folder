import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { 
  FolderOpen, 
  Plus, 
  LogOut, 
  MessageSquare, 
  Loader2, 
  AlertCircle,
  FileText,
  FileSpreadsheet,
  Presentation,
  FileType,
  File,
  Image,
  FileCode,
  FileArchive,
  Trash2,
  Eye,
  ChevronDown,
  ChevronRight,
  AlertTriangle
} from 'lucide-react'
import { api } from '../services/api'
import { PdfViewer } from './PdfViewer/PdfViewer'

interface Folder {
  id: string
  name: string
  status: string
  file_count: number
  index_mode?: 'gemini_files' | 'chroma' | null
}

interface FileInfo {
  id: string
  name: string
  path: string
  mime_type: string
  size?: number
}

interface DashboardProps {
  user: { id: string; email: string; name: string } | null
  onLogout: () => void
}

function getFileIcon(name: string, fileCount: number) {
  const lowerName = name.toLowerCase()
  
  if (fileCount > 1) {
    return <FolderOpen className="w-6 h-6 text-yellow-600" />
  }
  
  // Google Docs
  if (lowerName.includes('doc') || lowerName.endsWith('.docx') || lowerName.endsWith('.doc')) {
    return <FileText className="w-6 h-6 text-blue-600" />
  }
  
  // Google Sheets
  if (lowerName.includes('sheet') || lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls') || lowerName.endsWith('.csv')) {
    return <FileSpreadsheet className="w-6 h-6 text-green-600" />
  }
  
  // Google Slides
  if (lowerName.includes('slide') || lowerName.includes('presentation') || lowerName.endsWith('.pptx') || lowerName.endsWith('.ppt')) {
    return <Presentation className="w-6 h-6 text-orange-500" />
  }
  
  // PDF
  if (lowerName.endsWith('.pdf')) {
    return <FileType className="w-6 h-6 text-red-600" />
  }
  
  // Images
  if (lowerName.endsWith('.png') || lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg') || lowerName.endsWith('.gif') || lowerName.endsWith('.webp')) {
    return <Image className="w-6 h-6 text-purple-600" />
  }
  
  // Code files
  if (lowerName.endsWith('.js') || lowerName.endsWith('.ts') || lowerName.endsWith('.py') || lowerName.endsWith('.html') || lowerName.endsWith('.css') || lowerName.endsWith('.json')) {
    return <FileCode className="w-6 h-6 text-gray-700" />
  }
  
  // Archive
  if (lowerName.endsWith('.zip') || lowerName.endsWith('.rar') || lowerName.endsWith('.tar') || lowerName.endsWith('.gz')) {
    return <FileArchive className="w-6 h-6 text-amber-600" />
  }
  
  // Text/Markdown
  if (lowerName.endsWith('.txt') || lowerName.endsWith('.md')) {
    return <FileText className="w-6 h-6 text-gray-600" />
  }
  
  // Default file icon
  return <File className="w-6 h-6 text-gray-500" />
}

function getFileDescription(fileCount: number, status: string) {
  if (status === 'pending' || status === 'indexing') {
    return 'Processing...'
  }
  if (fileCount === 0) {
    return 'No files indexed'
  }
  if (fileCount === 1) {
    return '1 file indexed'
  }
  return `${fileCount} files indexed`
}

export function Dashboard({ user, onLogout }: DashboardProps) {
  const [folders, setFolders] = useState<Folder[]>([])
  const [folderUrl, setFolderUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedFolder, setExpandedFolder] = useState<string | null>(null)
  const [folderFiles, setFolderFiles] = useState<Record<string, FileInfo[]>>({})
  const [loadingFiles, setLoadingFiles] = useState<string | null>(null)
  const [pdfViewer, setPdfViewer] = useState<{ folderId: string; fileId: string; fileName: string } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    loadFolders()
    const interval = setInterval(loadFolders, 3000)
    return () => clearInterval(interval)
  }, [])

  const loadFolders = async () => {
    try {
      const data = await api.getFolders()
      setFolders(data)
    } catch (err) {
      console.error('Failed to load folders:', err)
    }
  }

  const handleAddFolder = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!folderUrl.trim()) return

    setLoading(true)
    setError(null)

    try {
      await api.addFolder(folderUrl)
      setFolderUrl('')
      loadFolders()
    } catch (err: unknown) {
      const error = err as { response?: { data?: { detail?: string } } }
      setError(error.response?.data?.detail || 'Failed to add content')
    } finally {
      setLoading(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleteConfirm) return
    
    setDeleting(deleteConfirm.id)
    setDeleteConfirm(null)
    try {
      await api.deleteFolder(deleteConfirm.id)
      loadFolders()
    } catch (err: unknown) {
      const error = err as { response?: { data?: { detail?: string } } }
      setError(error.response?.data?.detail || 'Failed to delete')
    } finally {
      setDeleting(null)
    }
  }

  const toggleFolderExpand = async (folderId: string) => {
    if (expandedFolder === folderId) {
      setExpandedFolder(null)
      return
    }
    
    setExpandedFolder(folderId)
    if (!folderFiles[folderId]) {
      setLoadingFiles(folderId)
      try {
        const files = await api.getFolderFiles(folderId)
        setFolderFiles((prev) => ({ ...prev, [folderId]: files }))
      } catch (err) {
        console.error('Failed to load files:', err)
      } finally {
        setLoadingFiles(null)
      }
    }
  }

  const handleFileClick = (folderId: string, file: FileInfo) => {
    if (file.mime_type === 'application/pdf') {
      setPdfViewer({ folderId, fileId: file.id, fileName: file.name })
    } else {
      window.open(api.getFileViewUrl(folderId, file.id), '_blank')
    }
  }

  const getFileTypeIcon = (mimeType: string) => {
    if (mimeType === 'application/pdf') return <FileType className="w-4 h-4 text-red-600" />
    if (mimeType.includes('document') || mimeType.includes('word')) return <FileText className="w-4 h-4 text-blue-600" />
    if (mimeType.includes('sheet') || mimeType.includes('excel')) return <FileSpreadsheet className="w-4 h-4 text-green-600" />
    if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return <Presentation className="w-4 h-4 text-orange-500" />
    return <File className="w-4 h-4 text-gray-500" />
  }

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      pending: 'bg-yellow-100 text-yellow-800',
      indexing: 'bg-blue-100 text-blue-800',
      ready: 'bg-green-100 text-green-800',
      failed: 'bg-red-100 text-red-800',
    }
    return styles[status] || 'bg-gray-100 text-gray-800'
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 p-2 rounded-lg">
              <FolderOpen className="w-6 h-6 text-white" />
            </div>
            <h1 className="text-xl font-semibold">Talk2Folder</h1>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-600">{user?.email}</span>
            <button
              onClick={onLogout}
              className="text-gray-500 hover:text-gray-700"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8">
        <div className="bg-white rounded-xl shadow-sm border p-6 mb-8">
          <h2 className="text-lg font-medium mb-4">Add Google Drive Content</h2>
          <form onSubmit={handleAddFolder} className="flex gap-3">
            <input
              type="text"
              value={folderUrl}
              onChange={(e) => setFolderUrl(e.target.value)}
              placeholder="Paste any Google Drive link (folder, doc, sheet, slides, PDF...)..."
              className="flex-1 px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="submit"
              disabled={loading || !folderUrl.trim()}
              className="flex items-center gap-2 bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Plus className="w-5 h-5" />}
              Add
            </button>
          </form>
          {error && (
            <div className="mt-3 flex items-center gap-2 text-red-600 text-sm">
              <AlertCircle className="w-4 h-4" />
              {error}
            </div>
          )}
          <p className="mt-3 text-sm text-gray-500">
            If you can open it in your browser when logged into Google Drive, the app can read it with your permissions.
          </p>
        </div>

        <h2 className="text-lg font-medium mb-4">Your Content</h2>
        {folders.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm border p-8 text-center text-gray-500">
            No content added yet. Paste a Google Drive link above to get started.
          </div>
        ) : (
          <div className="grid gap-4">
            {folders.map((folder) => (
              <div key={folder.id} className="bg-white rounded-xl shadow-sm border overflow-hidden">
                <div className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <button
                      onClick={() => folder.status === 'ready' && toggleFolderExpand(folder.id)}
                      disabled={folder.status !== 'ready'}
                      className="bg-gray-100 p-3 rounded-lg hover:bg-gray-200 disabled:hover:bg-gray-100 transition-colors"
                    >
                      {expandedFolder === folder.id ? (
                        <ChevronDown className="w-6 h-6 text-gray-600" />
                      ) : folder.file_count > 1 ? (
                        <ChevronRight className="w-6 h-6 text-gray-600" />
                      ) : (
                        getFileIcon(folder.name, folder.file_count)
                      )}
                    </button>
                    <div>
                      <h3 className="font-medium">{folder.name}</h3>
                      <p className="text-sm text-gray-500">{getFileDescription(folder.file_count, folder.status)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`px-3 py-1 rounded-full text-xs font-medium ${getStatusBadge(folder.status)}`}>
                      {folder.status}
                    </span>
                    {folder.file_count === 1 && folder.status === 'ready' && (
                      <button
                        onClick={() => {
                          const isPdf = folder.name.toLowerCase().endsWith('.pdf')
                          if (isPdf) {
                            toggleFolderExpand(folder.id)
                            setTimeout(() => {
                              const files = folderFiles[folder.id]
                              if (files?.[0]) handleFileClick(folder.id, files[0])
                            }, 500)
                          } else {
                            toggleFolderExpand(folder.id)
                          }
                        }}
                        className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                        title={folder.name.toLowerCase().endsWith('.pdf') ? 'View & Split PDF' : 'View file'}
                      >
                        <Eye className="w-5 h-5" />
                      </button>
                    )}
                    <button
                      onClick={() => navigate(`/chat/${folder.id}`)}
                      disabled={folder.status !== 'ready'}
                      className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <MessageSquare className="w-4 h-4" />
                      Chat
                    </button>
                    <button
                      onClick={() => setDeleteConfirm({ id: folder.id, name: folder.name })}
                      disabled={deleting === folder.id}
                      className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                      title="Delete"
                    >
                      {deleting === folder.id ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                      ) : (
                        <Trash2 className="w-5 h-5" />
                      )}
                    </button>
                  </div>
                </div>
                
                {expandedFolder === folder.id && (
                  <div className="border-t bg-gray-50 p-4">
                    {loadingFiles === folder.id ? (
                      <div className="flex items-center justify-center py-4">
                        <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                      </div>
                    ) : folderFiles[folder.id]?.length > 0 ? (
                      <div className="space-y-2">
                        {folderFiles[folder.id].map((file) => (
                          <div
                            key={file.id}
                            className="flex items-center justify-between p-2 bg-white rounded-lg border hover:border-blue-300 transition-colors"
                          >
                            <div className="flex items-center gap-3">
                              {getFileTypeIcon(file.mime_type)}
                              <span className="text-sm">{file.name}</span>
                            </div>
                            <button
                              onClick={() => handleFileClick(folder.id, file)}
                              className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                              title={file.mime_type === 'application/pdf' ? 'View & Split PDF' : 'View file'}
                            >
                              <Eye className="w-4 h-4" />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-gray-500 text-center py-4">No files found</p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </main>

      {pdfViewer && (
        <PdfViewer
          folderId={pdfViewer.folderId}
          fileId={pdfViewer.fileId}
          fileName={pdfViewer.fileName}
          onClose={() => setPdfViewer(null)}
        />
      )}

      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="bg-red-100 p-2 rounded-full">
                <AlertTriangle className="w-6 h-6 text-red-600" />
              </div>
              <h3 className="text-lg font-semibold">Delete Content</h3>
            </div>
            
            <p className="text-gray-600 mb-2">
              Are you sure you want to delete:
            </p>
            <p className="font-medium text-gray-900 mb-4 break-words">
              "{deleteConfirm.name}"
            </p>
            <p className="text-sm text-gray-500 mb-6">
              This will remove all indexed data and conversations. This action cannot be undone.
            </p>
            
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 font-medium"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 font-medium"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
