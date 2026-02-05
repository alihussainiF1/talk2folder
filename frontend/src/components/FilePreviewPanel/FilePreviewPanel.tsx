import { X, ExternalLink, FileText, Image, FileSpreadsheet, Presentation, File } from 'lucide-react'

interface FilePreviewPanelProps {
  file: {
    file_name: string
    file_id?: string
    drive_file_id?: string
    mime_type?: string
  } | null
  onClose: () => void
}

const getFileIcon = (mimeType: string) => {
  if (mimeType.includes('pdf') || mimeType.includes('document')) return FileText
  if (mimeType.includes('image')) return Image
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return FileSpreadsheet
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return Presentation
  return File
}

const getGoogleDriveEmbedUrl = (fileId: string) => {
  return `https://drive.google.com/file/d/${fileId}/preview`
}

const getGoogleDriveViewUrl = (fileId: string) => {
  return `https://drive.google.com/file/d/${fileId}/view`
}

export function FilePreviewPanel({ file, onClose }: FilePreviewPanelProps) {
  if (!file) return null

  const fileId = file.drive_file_id || file.file_id
  const Icon = getFileIcon(file.mime_type || '')

  return (
    <div className="w-[480px] bg-white border-l border-gray-200 flex flex-col h-full shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="flex-shrink-0 p-2 bg-blue-100 rounded-lg">
            <Icon className="w-5 h-5 text-blue-600" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="font-medium text-gray-900 truncate" title={file.file_name}>
              {file.file_name}
            </h3>
            {file.mime_type && (
              <p className="text-xs text-gray-500 truncate">
                {file.mime_type.split('/').pop()?.toUpperCase()}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {fileId && (
            <a
              href={getGoogleDriveViewUrl(fileId)}
              target="_blank"
              rel="noopener noreferrer"
              className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              title="Open in Google Drive"
            >
              <ExternalLink className="w-4 h-4" />
            </a>
          )}
          <button
            onClick={onClose}
            className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Preview Content */}
      <div className="flex-1 bg-gray-100 overflow-hidden">
        {fileId ? (
          <iframe
            src={getGoogleDriveEmbedUrl(fileId)}
            className="w-full h-full border-0"
            title={`Preview of ${file.file_name}`}
            allow="autoplay"
            sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
          />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500">
            <div className="text-center p-8">
              <Icon className="w-16 h-16 mx-auto mb-4 text-gray-300" />
              <p className="text-sm">Preview not available</p>
              <p className="text-xs text-gray-400 mt-1">File ID not found</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
