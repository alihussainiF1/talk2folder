from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    database_url: str
    chroma_host: str = "chromadb"
    chroma_port: int = 8000
    
    google_client_id: str
    google_client_secret: str
    google_api_key: str
    
    jwt_secret: str
    jwt_algorithm: str = "HS256"
    jwt_expiration_hours: int = 24
    
    frontend_url: str = "http://localhost:3009"
    
    class Config:
        env_file = ".env"


@lru_cache
def get_settings() -> Settings:
    return Settings()
