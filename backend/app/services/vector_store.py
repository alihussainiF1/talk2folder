import chromadb
from chromadb.config import Settings
import json

from app.config import get_settings

settings = get_settings()

client = chromadb.HttpClient(
    host=settings.chroma_host,
    port=settings.chroma_port,
    settings=Settings(anonymized_telemetry=False),
)

MANIFEST_PREFIX = "_manifest_"


def _get_collection_name(user_id: str, folder_id: str) -> str:
    return f"user_{user_id}_folder_{folder_id}".replace("-", "_")


def get_collection(user_id: str, folder_id: str):
    collection_name = _get_collection_name(user_id, folder_id)
    return client.get_or_create_collection(
        name=collection_name,
        metadata={"hnsw:space": "cosine"},
    )


def add_documents(
    user_id: str,
    folder_id: str,
    documents: list[str],
    metadatas: list[dict],
    ids: list[str],
):
    collection = get_collection(user_id, folder_id)
    batch_size = 100
    for i in range(0, len(documents), batch_size):
        batch_docs = documents[i:i + batch_size]
        batch_metas = metadatas[i:i + batch_size]
        batch_ids = ids[i:i + batch_size]
        collection.upsert(documents=batch_docs, metadatas=batch_metas, ids=batch_ids)


def store_file_manifest(user_id: str, folder_id: str, files: list[dict]):
    collection = get_collection(user_id, folder_id)
    manifest_json = json.dumps(files)
    manifest_summary = f"This folder contains {len(files)} files: " + ", ".join(f["name"] for f in files[:50])
    if len(files) > 50:
        manifest_summary += f" and {len(files) - 50} more files."
    
    collection.upsert(
        documents=[manifest_summary],
        metadatas=[{"type": "manifest", "manifest_json": manifest_json}],
        ids=[f"{MANIFEST_PREFIX}{folder_id}"],
    )


def get_file_manifest(user_id: str, folder_id: str) -> list[dict]:
    collection = get_collection(user_id, folder_id)
    try:
        results = collection.get(
            ids=[f"{MANIFEST_PREFIX}{folder_id}"],
            include=["metadatas"],
        )
        if results["metadatas"] and results["metadatas"][0]:
            manifest_json = results["metadatas"][0].get("manifest_json", "[]")
            return json.loads(manifest_json)
    except Exception:
        pass
    return []


def search_documents(
    user_id: str,
    folder_id: str,
    query: str,
    n_results: int = 10,
    file_name_filter: str | None = None,
) -> list[dict]:
    collection = get_collection(user_id, folder_id)
    
    where_filter = {"type": {"$ne": "manifest"}}
    if file_name_filter:
        where_filter = {"$and": [
            {"type": {"$ne": "manifest"}},
            {"file_name": {"$eq": file_name_filter}},
        ]}
    
    try:
        results = collection.query(
            query_texts=[query],
            n_results=n_results,
            where=where_filter,
            include=["documents", "metadatas", "distances"],
        )
    except Exception:
        results = collection.query(
            query_texts=[query],
            n_results=n_results,
            include=["documents", "metadatas", "distances"],
        )
    
    documents = []
    if results["documents"] and results["documents"][0]:
        for i, doc in enumerate(results["documents"][0]):
            meta = results["metadatas"][0][i] if results["metadatas"] else {}
            if meta.get("type") == "manifest":
                continue
            documents.append({
                "content": doc,
                "metadata": meta,
                "distance": results["distances"][0][i] if results["distances"] else 0,
            })
    
    return documents


def get_collection_stats(user_id: str, folder_id: str) -> dict:
    collection = get_collection(user_id, folder_id)
    count = collection.count()
    manifest = get_file_manifest(user_id, folder_id)
    return {
        "total_chunks": count - 1 if count > 0 else 0,
        "total_files": len(manifest),
        "files": manifest,
    }


def delete_collection(user_id: str, folder_id: str):
    collection_name = _get_collection_name(user_id, folder_id)
    try:
        client.delete_collection(collection_name)
    except Exception:
        pass
