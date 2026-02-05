from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from fastapi.responses import StreamingResponse, FileResponse
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from pathlib import Path
from datetime import date
import re
import uuid
import io
import os

from app.db.database import get_db
from app.db.models import User, Folder, FolderStatus, Conversation, Message
from app.api.dependencies import get_current_user
from app.services.google_drive import GoogleDriveService
from app.services.ingestion import ingest_folder, ingest_single_file
from app.services import vector_store
from pypdf import PdfReader, PdfWriter

AGENT_SESSIONS_DIR = Path("/app/agent_sessions")

router = APIRouter()


class FolderLinkRequest(BaseModel):
    folder_url: str


class FolderResponse(BaseModel):
    id: str
    name: str
    status: str
    file_count: int
    index_mode: str | None = None
    gemini_files: list[dict] | None = None

    class Config:
        from_attributes = True


def extract_drive_id(url: str) -> tuple[str, str]:
    """Extract ID and type from Google Drive URL.
    
    Returns:
        tuple of (id, type) where type is 'folder' or 'file'
    """
    patterns = [
        (r"folders/([a-zA-Z0-9_-]+)", "folder"),
        (r"document/d/([a-zA-Z0-9_-]+)", "file"),
        (r"spreadsheets/d/([a-zA-Z0-9_-]+)", "file"),
        (r"presentation/d/([a-zA-Z0-9_-]+)", "file"),
        (r"file/d/([a-zA-Z0-9_-]+)", "file"),
        (r"id=([a-zA-Z0-9_-]+)", "unknown"),
    ]
    
    for pattern, drive_type in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1), drive_type
    
    raise ValueError("Could not extract ID from Google Drive URL")


@router.post("/folders", response_model=FolderResponse)
async def add_folder(
    request: FolderLinkRequest,
    background_tasks: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        drive_id, drive_type = extract_drive_id(request.folder_url)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid Google Drive URL")
    
    result = await db.execute(
        select(Folder).where(Folder.user_id == user.id, Folder.drive_folder_id == drive_id)
    )
    existing = result.scalar_one_or_none()
    
    drive_service = GoogleDriveService(user.refresh_token)
    
    if existing:
        if existing.status == FolderStatus.FAILED:
            existing.status = FolderStatus.PENDING
            await db.commit()
            await db.refresh(existing)
            
            if drive_type == "unknown":
                metadata = await drive_service.get_file_metadata(drive_id)
                drive_type = "folder" if metadata.get("mimeType") == "application/vnd.google-apps.folder" else "file"
            
            if drive_type == "folder":
                background_tasks.add_task(ingest_folder, str(existing.id), str(user.id), user.refresh_token)
            else:
                metadata = await drive_service.get_file_metadata(drive_id)
                background_tasks.add_task(ingest_single_file, str(existing.id), str(user.id), user.refresh_token, drive_id, metadata)
        
        return FolderResponse(
            id=str(existing.id),
            name=existing.name,
            status=existing.status.value,
            file_count=existing.file_count,
        )
    
    if drive_type == "unknown":
        metadata = await drive_service.get_file_metadata(drive_id)
        drive_type = "folder" if metadata.get("mimeType") == "application/vnd.google-apps.folder" else "file"
    
    if drive_type == "folder":
        metadata = await drive_service.get_folder_metadata(drive_id)
    else:
        metadata = await drive_service.get_file_metadata(drive_id)
    
    folder = Folder(
        user_id=user.id,
        drive_folder_id=drive_id,
        name=metadata["name"],
        status=FolderStatus.PENDING,
    )
    db.add(folder)
    await db.commit()
    await db.refresh(folder)
    
    if drive_type == "folder":
        background_tasks.add_task(ingest_folder, str(folder.id), str(user.id), user.refresh_token)
    else:
        background_tasks.add_task(ingest_single_file, str(folder.id), str(user.id), user.refresh_token, drive_id, metadata)
    
    return FolderResponse(
        id=str(folder.id),
        name=folder.name,
        status=folder.status.value,
        file_count=folder.file_count,
    )


@router.get("/folders", response_model=list[FolderResponse])
async def list_folders(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Folder).where(Folder.user_id == user.id))
    folders = result.scalars().all()
    return [
        FolderResponse(
            id=str(f.id),
            name=f.name,
            status=f.status.value,
            file_count=f.file_count,
            index_mode=f.index_mode.value if f.index_mode else None,
        )
        for f in folders
    ]


@router.get("/folders/{folder_id}", response_model=FolderResponse)
async def get_folder(
    folder_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Folder).where(Folder.id == uuid.UUID(folder_id), Folder.user_id == user.id)
    )
    folder = result.scalar_one_or_none()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    
    return FolderResponse(
        id=str(folder.id),
        name=folder.name,
        status=folder.status.value,
        file_count=folder.file_count,
        index_mode=folder.index_mode.value if folder.index_mode else None,
        gemini_files=folder.gemini_files,
    )


@router.post("/folders/{folder_id}/reindex")
async def reindex_folder(
    folder_id: str,
    background_tasks: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Folder).where(Folder.id == uuid.UUID(folder_id), Folder.user_id == user.id)
    )
    folder = result.scalar_one_or_none()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    
    vector_store.delete_collection(str(user.id), folder_id)
    
    folder.status = FolderStatus.PENDING
    folder.file_count = 0
    folder.index_mode = None
    folder.gemini_files = None
    await db.commit()
    await db.refresh(folder)
    
    drive_service = GoogleDriveService(user.refresh_token)
    metadata = await drive_service.get_file_metadata(folder.drive_folder_id)
    is_folder = metadata.get("mimeType") == "application/vnd.google-apps.folder"
    
    if is_folder:
        background_tasks.add_task(ingest_folder, str(folder.id), str(user.id), user.refresh_token)
    else:
        background_tasks.add_task(ingest_single_file, str(folder.id), str(user.id), user.refresh_token, folder.drive_folder_id, metadata)
    
    return FolderResponse(
        id=str(folder.id),
        name=folder.name,
        status=folder.status.value,
        file_count=folder.file_count,
        index_mode=folder.index_mode.value if folder.index_mode else None,
    )


@router.delete("/folders/{folder_id}")
async def delete_folder(
    folder_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Folder).where(Folder.id == uuid.UUID(folder_id), Folder.user_id == user.id)
    )
    folder = result.scalar_one_or_none()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    
    conversations = await db.execute(
        select(Conversation).where(Conversation.folder_id == folder.id)
    )
    for conv in conversations.scalars().all():
        await db.execute(delete(Message).where(Message.conversation_id == conv.id))
    await db.execute(delete(Conversation).where(Conversation.folder_id == folder.id))
    
    vector_store.delete_collection(str(user.id), folder_id)
    
    await db.delete(folder)
    await db.commit()
    
    return {"status": "deleted"}


class FileInfo(BaseModel):
    id: str
    name: str
    path: str
    mime_type: str
    size: int | None = None


@router.get("/folders/{folder_id}/files", response_model=list[FileInfo])
async def list_folder_files(
    folder_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Folder).where(Folder.id == uuid.UUID(folder_id), Folder.user_id == user.id)
    )
    folder = result.scalar_one_or_none()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    
    manifest = vector_store.get_file_manifest(str(user.id), folder_id)
    return [
        FileInfo(
            id=f.get("id", ""),
            name=f.get("name", ""),
            path=f.get("path", f.get("name", "")),
            mime_type=f.get("mime_type", ""),
            size=f.get("size"),
        )
        for f in manifest
    ]


@router.get("/folders/{folder_id}/files/{file_id}/view")
async def view_file(
    folder_id: str,
    file_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Folder).where(Folder.id == uuid.UUID(folder_id), Folder.user_id == user.id)
    )
    folder = result.scalar_one_or_none()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    
    drive_service = GoogleDriveService(user.refresh_token)
    
    try:
        metadata = await drive_service.get_file_metadata(file_id)
        mime_type = metadata.get("mimeType", "application/octet-stream")
        file_name = metadata.get("name", "file")
        
        content = await drive_service.download_file(file_id, mime_type)
        
        if mime_type == "application/vnd.google-apps.document":
            mime_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        elif mime_type == "application/vnd.google-apps.spreadsheet":
            mime_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        elif mime_type == "application/vnd.google-apps.presentation":
            mime_type = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        
        return StreamingResponse(
            io.BytesIO(content),
            media_type=mime_type,
            headers={"Content-Disposition": f'inline; filename="{file_name}"'},
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to retrieve file: {str(e)}")


class SplitPdfRequest(BaseModel):
    pages: list[int] | None = None
    split_all: bool = False


class SplitPdfResponse(BaseModel):
    files: list[dict]


@router.get("/folders/{folder_id}/files/{file_id}/pdf-info")
async def get_pdf_info(
    folder_id: str,
    file_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Folder).where(Folder.id == uuid.UUID(folder_id), Folder.user_id == user.id)
    )
    folder = result.scalar_one_or_none()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    
    drive_service = GoogleDriveService(user.refresh_token)
    
    try:
        metadata = await drive_service.get_file_metadata(file_id)
        mime_type = metadata.get("mimeType", "")
        
        if mime_type != "application/pdf":
            raise HTTPException(status_code=400, detail="File is not a PDF")
        
        content = await drive_service.download_file(file_id, mime_type)
        reader = PdfReader(io.BytesIO(content))
        
        return {
            "name": metadata.get("name", ""),
            "page_count": len(reader.pages),
            "file_id": file_id,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read PDF: {str(e)}")


@router.post("/folders/{folder_id}/files/{file_id}/split")
async def split_pdf(
    folder_id: str,
    file_id: str,
    request: SplitPdfRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from datetime import date
    from pathlib import Path
    
    result = await db.execute(
        select(Folder).where(Folder.id == uuid.UUID(folder_id), Folder.user_id == user.id)
    )
    folder = result.scalar_one_or_none()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    
    drive_service = GoogleDriveService(user.refresh_token)
    
    try:
        metadata = await drive_service.get_file_metadata(file_id)
        mime_type = metadata.get("mimeType", "")
        file_name = metadata.get("name", "document.pdf").replace(".pdf", "")
        
        if mime_type != "application/pdf":
            raise HTTPException(status_code=400, detail="File is not a PDF")
        
        content = await drive_service.download_file(file_id, mime_type)
        reader = PdfReader(io.BytesIO(content))
        total_pages = len(reader.pages)
        
        if request.split_all:
            pages_to_extract = list(range(1, total_pages + 1))
        elif request.pages:
            pages_to_extract = [p for p in request.pages if 1 <= p <= total_pages]
        else:
            raise HTTPException(status_code=400, detail="Specify pages or set split_all=true")
        
        today = date.today().isoformat()
        session_dir = Path("/app/agent_sessions") / today
        session_dir.mkdir(parents=True, exist_ok=True)
        
        writer = PdfWriter()
        for page_num in pages_to_extract:
            writer.add_page(reader.pages[page_num - 1])
        
        pages_str = "_".join(map(str, pages_to_extract[:3]))
        if len(pages_to_extract) > 3:
            pages_str += f"_etc_{len(pages_to_extract)}pages"
        output_filename = f"{file_name}_pages_{pages_str}.pdf"
        output_path = session_dir / output_filename
        
        with open(output_path, "wb") as f:
            writer.write(f)
        
        return {
            "file": {
                "name": output_filename,
                "path": str(output_path),
                "size": output_path.stat().st_size,
                "pages": pages_to_extract,
            },
            "total_pages": total_pages,
            "output_folder": str(session_dir),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to split PDF: {str(e)}")


@router.get("/folders/{folder_id}/files/{file_id}/split/{page_num}")
async def download_split_page(
    folder_id: str,
    file_id: str,
    page_num: int,
    session_date: str = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from datetime import date
    from pathlib import Path
    
    result = await db.execute(
        select(Folder).where(Folder.id == uuid.UUID(folder_id), Folder.user_id == user.id)
    )
    folder = result.scalar_one_or_none()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    
    drive_service = GoogleDriveService(user.refresh_token)
    
    try:
        metadata = await drive_service.get_file_metadata(file_id)
        file_name = metadata.get("name", "document.pdf").replace(".pdf", "")
        
        today = session_date or date.today().isoformat()
        file_path = Path("/app/agent_sessions") / today / file_name / f"{file_name}_page_{page_num}.pdf"
        
        if file_path.exists():
            return StreamingResponse(
                open(file_path, "rb"),
                media_type="application/pdf",
                headers={"Content-Disposition": f'attachment; filename="{file_name}_page_{page_num}.pdf"'},
            )
        
        raise HTTPException(status_code=404, detail="Split page not found. Please split the PDF first.")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to download page: {str(e)}")


@router.get("/agent-sessions")
async def list_agent_sessions(user: User = Depends(get_current_user)):
    if not AGENT_SESSIONS_DIR.exists():
        return {"sessions": []}
    
    sessions = []
    for date_dir in sorted(AGENT_SESSIONS_DIR.iterdir(), reverse=True):
        if date_dir.is_dir():
            files = []
            for doc_dir in date_dir.iterdir():
                if doc_dir.is_dir():
                    doc_files = [f.name for f in doc_dir.iterdir() if f.is_file()]
                    files.append({"document": doc_dir.name, "files": doc_files})
            sessions.append({"date": date_dir.name, "documents": files})
    
    return {"sessions": sessions}


@router.get("/agent-sessions/{session_date}/{document}/{filename}")
async def download_session_file(
    session_date: str,
    document: str,
    filename: str,
    user: User = Depends(get_current_user),
):
    file_path = AGENT_SESSIONS_DIR / session_date / document / filename
    
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    
    return FileResponse(
        file_path,
        media_type="application/pdf",
        filename=filename,
    )
