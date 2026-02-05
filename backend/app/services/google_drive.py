from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
import io
import asyncio
from functools import partial
from concurrent.futures import ThreadPoolExecutor
from tenacity import retry, stop_after_attempt, wait_exponential_jitter

from app.config import get_settings

settings = get_settings()

SUPPORTED_MIME_TYPES = {
    "application/pdf": "pdf",
    "application/vnd.google-apps.document": "gdoc",
    "application/vnd.google-apps.spreadsheet": "gsheet",
    "application/vnd.google-apps.presentation": "gslides",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/msword": "doc",
    "application/vnd.ms-excel": "xls",
    "application/vnd.ms-powerpoint": "ppt",
    "text/plain": "txt",
    "text/markdown": "md",
    "text/csv": "csv",
    "text/html": "html",
    "application/json": "json",
    "application/rtf": "rtf",
    "text/rtf": "rtf",
    "text/x-python": "py",
    "application/x-python-code": "py",
    "text/javascript": "js",
    "application/javascript": "js",
    "text/x-java-source": "java",
    "text/x-c": "c",
    "text/x-c++src": "cpp",
    "text/x-csharp": "cs",
    "text/x-go": "go",
    "text/x-rust": "rs",
    "text/x-typescript": "ts",
    "application/xml": "xml",
    "text/xml": "xml",
    "application/x-yaml": "yaml",
    "text/yaml": "yaml",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
}

EXPORT_MIME_TYPES = {
    "application/vnd.google-apps.document": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.google-apps.spreadsheet": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.google-apps.presentation": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

_executor = ThreadPoolExecutor(max_workers=10)


class GoogleDriveService:
    def __init__(self, refresh_token: str):
        self.refresh_token = refresh_token

    def _build_service(self):
        credentials = Credentials(
            token=None,
            refresh_token=self.refresh_token,
            token_uri="https://oauth2.googleapis.com/token",
            client_id=settings.google_client_id,
            client_secret=settings.google_client_secret,
        )
        return build("drive", "v3", credentials=credentials)
    
    async def get_folder_metadata(self, folder_id: str) -> dict:
        loop = asyncio.get_running_loop()
        def _get_folder():
            service = self._build_service()
            return service.files().get(
                fileId=folder_id,
                fields="id,name",
                supportsAllDrives=True,
            ).execute()
        result = await loop.run_in_executor(
            _executor,
            _get_folder,
        )
        return result
    
    async def get_file_metadata(self, file_id: str) -> dict:
        loop = asyncio.get_running_loop()
        def _get_file():
            service = self._build_service()
            return service.files().get(
                fileId=file_id,
                fields="id,name,mimeType,size,modifiedTime",
                supportsAllDrives=True,
            ).execute()
        result = await loop.run_in_executor(
            _executor,
            _get_file,
        )
        return result
    
    async def _list_single_folder(self, folder_id: str, path: str) -> tuple[list[dict], list[tuple[str, str]]]:
        loop = asyncio.get_running_loop()
        files = []
        subfolders = []
        page_token = None
        
        while True:
            query = f"'{folder_id}' in parents and trashed = false"
            print(f"[Drive] Querying folder: {folder_id} with query: {query}")
            def _list_page(token):
                service = self._build_service()
                try:
                    result = service.files().list(
                        q=query,
                        fields="nextPageToken,files(id,name,mimeType,size,modifiedTime)",
                        pageToken=token,
                        pageSize=100,
                        supportsAllDrives=True,
                        includeItemsFromAllDrives=True,
                    ).execute()
                    print(f"[Drive] API response: {result}")
                    return result
                except Exception as e:
                    print(f"[Drive] API ERROR: {type(e).__name__}: {e}")
                    raise
            result = await loop.run_in_executor(
                _executor,
                _list_page,
                page_token,
            )
            
            raw_files = result.get("files", [])
            print(f"[Drive] Listed {len(raw_files)} items in folder {folder_id}")
            
            for file in raw_files:
                file_path = f"{path}/{file['name']}" if path else file["name"]
                file["path"] = file_path
                mime = file.get("mimeType", "unknown")
                
                if mime == "application/vnd.google-apps.folder":
                    subfolders.append((file["id"], file_path))
                elif mime in SUPPORTED_MIME_TYPES:
                    files.append(file)
                else:
                    print(f"[Drive] Skipping unsupported: {file['name']} ({mime})")
            
            page_token = result.get("nextPageToken")
            if not page_token:
                break
        
        return files, subfolders
    
    async def list_files(self, folder_id: str, recursive: bool = False) -> list[dict]:
        all_files = []
        files, subfolders = await self._list_single_folder(folder_id, "")
        all_files.extend(files)
        
        if recursive and subfolders:
            while subfolders:
                batch = subfolders[:10]
                subfolders = subfolders[10:]
                
                tasks = [self._list_single_folder(fid, fpath) for fid, fpath in batch]
                results = await asyncio.gather(*tasks, return_exceptions=True)
                
                for result in results:
                    if isinstance(result, Exception):
                        continue
                    sub_files, new_subfolders = result
                    all_files.extend(sub_files)
                    subfolders.extend(new_subfolders)
        
        return all_files
    
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential_jitter(initial=0.5, max=5, jitter=1),
        reraise=True,
        before_sleep=lambda retry_state: print(f"[Download] Retry {retry_state.attempt_number}/3: {type(retry_state.outcome.exception()).__name__}")
    )
    def _sync_download(self, file_id: str, mime_type: str) -> bytes:
        service = self._build_service()
        if mime_type in EXPORT_MIME_TYPES:
            export_mime = EXPORT_MIME_TYPES[mime_type]
            request = service.files().export_media(fileId=file_id, mimeType=export_mime)
        else:
            request = service.files().get_media(fileId=file_id, supportsAllDrives=True)
        
        buffer = io.BytesIO()
        downloader = MediaIoBaseDownload(buffer, request)
        done = False
        while not done:
            _, done = downloader.next_chunk()
        return buffer.getvalue()
    
    async def download_file(self, file_id: str, mime_type: str) -> bytes:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(_executor, self._sync_download, file_id, mime_type)
    
    async def download_files_parallel(self, files: list[dict], max_concurrent: int = 5) -> list[tuple[dict, bytes | None]]:
        semaphore = asyncio.Semaphore(max_concurrent)
        total = len(files)
        completed = 0
        progress_lock = asyncio.Lock()
        
        async def download_with_semaphore(file: dict) -> tuple[dict, bytes | None]:
            async with semaphore:
                try:
                    print(f"[Download] START: {file['name']}")
                    content = await asyncio.wait_for(
                        self.download_file(file["id"], file["mimeType"]),
                        timeout=60,
                    )
                    print(f"[Download] OK: {file['name']} ({len(content)} bytes)")
                    result = (file, content)
                except asyncio.TimeoutError:
                    print(f"[Download] TIMEOUT: {file['name']}")
                    result = (file, None)
                except Exception as e:
                    print(f"[Download] FAILED: {file['name']} - {type(e).__name__}: {e}")
                    result = (file, None)
                
                nonlocal completed
                async with progress_lock:
                    completed += 1
                    print(f"[Download] Progress: {completed}/{total}")
                return result
        
        tasks = [download_with_semaphore(f) for f in files]
        return await asyncio.gather(*tasks)
