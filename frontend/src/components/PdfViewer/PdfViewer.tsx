import { useState, useEffect, useMemo } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import {
  X,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Download,
  Scissors,
  Check,
  Loader2,
  FolderOpen,
  CheckCircle,
} from 'lucide-react'
import { api } from '../../services/api'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`

interface PdfViewerProps {
  folderId: string
  fileId: string
  fileName: string
  onClose: () => void
}

const THUMBNAILS_PER_PAGE = 12

export function PdfViewer({ folderId, fileId, fileName, onClose }: PdfViewerProps) {
  const [numPages, setNumPages] = useState<number>(0)
  const [pageNumber, setPageNumber] = useState(1)
  const [scale, setScale] = useState(1.0)
  const [splitMode, setSplitMode] = useState(false)
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set())
  const [splitting, setSplitting] = useState(false)
  const [pdfUrl, setPdfUrl] = useState<string>('')
  const [splitResult, setSplitResult] = useState<{ folder: string; fileName: string; filePath: string; pages: number[] } | null>(null)
  const [thumbnailPage, setThumbnailPage] = useState(0)
  const [docLoaded, setDocLoaded] = useState(false)

  const file = useMemo(() => api.getFileViewUrl(folderId, fileId), [folderId, fileId])

  useEffect(() => {
    setPdfUrl(file)
  }, [file])

  function onDocumentLoadSuccess({ numPages }: { numPages: number }) {
    setNumPages(numPages)
    setDocLoaded(true)
  }

  const goToPrevPage = () => setPageNumber((p) => Math.max(1, p - 1))
  const goToNextPage = () => setPageNumber((p) => Math.min(numPages, p + 1))
  const zoomIn = () => setScale((s) => Math.min(2, s + 0.2))
  const zoomOut = () => setScale((s) => Math.max(0.5, s - 0.2))

  const togglePageSelection = (page: number) => {
    const newSelected = new Set(selectedPages)
    if (newSelected.has(page)) {
      newSelected.delete(page)
    } else {
      newSelected.add(page)
    }
    setSelectedPages(newSelected)
  }

  const selectAllPages = () => {
    const allPages = new Set(Array.from({ length: numPages }, (_, i) => i + 1))
    setSelectedPages(allPages)
  }

  const clearSelection = () => setSelectedPages(new Set())

  const downloadSelectedPages = async () => {
    if (selectedPages.size === 0) return
    setSplitting(true)
    
    try {
      const pages = Array.from(selectedPages).sort((a, b) => a - b)
      const result = await api.splitPdf(folderId, fileId, pages)
      
      setSplitResult({
        folder: result.output_folder,
        fileName: result.file.name,
        filePath: result.file.path,
        pages: result.file.pages,
      })
      
      setSplitMode(false)
      setSelectedPages(new Set())
    } catch (err) {
      console.error('Failed to split PDF:', err)
      alert('Failed to split PDF. Please try again.')
    } finally {
      setSplitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex flex-col">
      <div className="bg-white border-b px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg">
            <X className="w-5 h-5" />
          </button>
          <h2 className="font-medium truncate max-w-md">{fileName}</h2>
          {numPages > 0 && (
            <span className="text-sm text-gray-500">
              Page {pageNumber} of {numPages}
            </span>
          )}
        </div>
        
        <div className="flex items-center gap-2">
          {!splitMode ? (
            <>
              <button
                onClick={zoomOut}
                className="p-2 hover:bg-gray-100 rounded-lg"
                title="Zoom out"
              >
                <ZoomOut className="w-5 h-5" />
              </button>
              <span className="text-sm w-16 text-center">{Math.round(scale * 100)}%</span>
              <button
                onClick={zoomIn}
                className="p-2 hover:bg-gray-100 rounded-lg"
                title="Zoom in"
              >
                <ZoomIn className="w-5 h-5" />
              </button>
              <div className="w-px h-6 bg-gray-200 mx-2" />
              <button
                onClick={() => setSplitMode(true)}
                className="flex items-center gap-2 px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                <Scissors className="w-4 h-4" />
                Split PDF
              </button>
            </>
          ) : (
            <>
              <input
                type="text"
                placeholder="e.g., 1-5, 8, 12-15"
                className="px-3 py-1.5 border rounded-lg text-sm w-36"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const input = (e.target as HTMLInputElement).value
                    const newSelected = new Set(selectedPages)
                    input.split(',').forEach((part) => {
                      const trimmed = part.trim()
                      if (trimmed.includes('-')) {
                        const [start, end] = trimmed.split('-').map(Number)
                        for (let i = start; i <= Math.min(end, numPages); i++) {
                          if (i >= 1) newSelected.add(i)
                        }
                      } else {
                        const page = Number(trimmed)
                        if (page >= 1 && page <= numPages) newSelected.add(page)
                      }
                    })
                    setSelectedPages(newSelected)
                    ;(e.target as HTMLInputElement).value = ''
                  }
                }}
              />
              <span className="text-sm text-gray-600">
                {selectedPages.size} selected
              </span>
              <button
                onClick={clearSelection}
                className="px-3 py-2 text-sm hover:bg-gray-100 rounded-lg"
              >
                Clear
              </button>
              <button
                onClick={downloadSelectedPages}
                disabled={selectedPages.size === 0 || splitting}
                className="flex items-center gap-2 px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
              >
                {splitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Download className="w-4 h-4" />
                )}
                Split & Save
              </button>
              <button
                onClick={() => {
                  setSplitMode(false)
                  setSelectedPages(new Set())
                  setThumbnailPage(0)
                }}
                className="px-3 py-2 text-sm hover:bg-gray-100 rounded-lg"
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-gray-800 flex justify-center py-8">
        {splitMode ? (
          <div className="flex flex-col items-center">
            <Document 
              file={file} 
              onLoadSuccess={onDocumentLoadSuccess}
              loading={
                <div className="flex items-center justify-center h-96">
                  <Loader2 className="w-8 h-8 animate-spin text-white" />
                </div>
              }
            >
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 p-4 max-w-5xl">
                {numPages > 0 && Array.from({ length: THUMBNAILS_PER_PAGE }, (_, i) => {
                  const page = thumbnailPage * THUMBNAILS_PER_PAGE + i + 1
                  if (page > numPages) return null
                  return (
                    <div
                      key={page}
                      onClick={() => togglePageSelection(page)}
                      className={`cursor-pointer relative bg-white rounded-lg overflow-hidden shadow-lg transition-transform hover:scale-105 ${
                        selectedPages.has(page) ? 'ring-4 ring-blue-500' : ''
                      }`}
                    >
                      <Page
                        pageNumber={page}
                        width={160}
                        renderAnnotationLayer={false}
                        renderTextLayer={false}
                        loading=""
                      />
                      <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-center py-1 text-sm">
                        Page {page}
                      </div>
                      {selectedPages.has(page) && (
                        <div className="absolute top-2 right-2 bg-blue-500 text-white rounded-full p-1">
                          <Check className="w-4 h-4" />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </Document>
            
            {numPages > 0 && (
              <div className="flex items-center gap-4 mt-4 bg-white/10 rounded-lg px-4 py-2">
                <button
                  onClick={() => setThumbnailPage((p) => Math.max(0, p - 1))}
                  disabled={thumbnailPage === 0}
                  className="p-2 text-white hover:bg-white/20 rounded disabled:opacity-30"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <span className="text-white text-sm">
                  Pages {thumbnailPage * THUMBNAILS_PER_PAGE + 1}-{Math.min((thumbnailPage + 1) * THUMBNAILS_PER_PAGE, numPages)} of {numPages}
                </span>
                <button
                  onClick={() => setThumbnailPage((p) => Math.min(Math.ceil(numPages / THUMBNAILS_PER_PAGE) - 1, p + 1))}
                  disabled={(thumbnailPage + 1) * THUMBNAILS_PER_PAGE >= numPages}
                  className="p-2 text-white hover:bg-white/20 rounded disabled:opacity-30"
                >
                  <ChevronRight className="w-5 h-5" />
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-4">
            <button
              onClick={goToPrevPage}
              disabled={pageNumber <= 1}
              className="p-3 bg-white/10 hover:bg-white/20 rounded-full text-white disabled:opacity-30"
            >
              <ChevronLeft className="w-6 h-6" />
            </button>
            
            <Document
              file={file}
              onLoadSuccess={onDocumentLoadSuccess}
              loading={
                !docLoaded ? (
                  <div className="flex items-center justify-center h-96 w-96 bg-white rounded-lg">
                    <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
                  </div>
                ) : null
              }
            >
              <Page
                pageNumber={pageNumber}
                scale={scale}
                className="shadow-2xl"
                renderAnnotationLayer={true}
                renderTextLayer={true}
                loading=""
              />
            </Document>
            
            <button
              onClick={goToNextPage}
              disabled={pageNumber >= numPages}
              className="p-3 bg-white/10 hover:bg-white/20 rounded-full text-white disabled:opacity-30"
            >
              <ChevronRight className="w-6 h-6" />
            </button>
          </div>
        )}
      </div>

      {!splitMode && numPages > 1 && (
        <div className="bg-white border-t px-4 py-3 flex justify-center gap-2">
          {Array.from({ length: Math.min(numPages, 10) }, (_, i) => {
            const start = Math.max(1, pageNumber - 5)
            const page = start + i
            if (page > numPages) return null
            return (
              <button
                key={page}
                onClick={() => setPageNumber(page)}
                className={`w-8 h-8 rounded ${
                  page === pageNumber
                    ? 'bg-blue-600 text-white'
                    : 'hover:bg-gray-100'
                }`}
              >
                {page}
              </button>
            )
          })}
        </div>
      )}

      {splitResult && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-60">
          <div className="bg-white rounded-xl p-6 max-w-lg w-full mx-4 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="bg-green-100 p-2 rounded-full">
                <CheckCircle className="w-6 h-6 text-green-600" />
              </div>
              <h3 className="text-lg font-semibold">PDF Created</h3>
            </div>
            
            <div className="bg-gray-50 rounded-lg p-4 mb-4">
              <p className="text-sm text-gray-600 mb-2">File created:</p>
              <code className="text-sm bg-gray-100 px-2 py-1 rounded block overflow-x-auto font-medium">
                {splitResult.fileName}
              </code>
            </div>
            
            <div className="mb-4">
              <p className="text-sm text-gray-600">
                Contains {splitResult.pages.length} page{splitResult.pages.length !== 1 ? 's' : ''}: {splitResult.pages.join(', ')}
              </p>
            </div>
            
            <div className="flex gap-3">
              <button
                onClick={() => {
                  const basePath = '/tmp/talk2folder_sessions/'
                  const relativePath = splitResult.filePath.replace(basePath, '')
                  const url = api.getSplitFileDownloadUrl(relativePath)
                  window.open(url, '_blank')
                }}
                className="flex-1 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center justify-center gap-2"
              >
                <Download className="w-4 h-4" />
                Download
              </button>
              <button
                onClick={() => setSplitResult(null)}
                className="flex-1 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
