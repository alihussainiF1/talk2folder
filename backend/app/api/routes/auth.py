from fastapi import APIRouter, Depends, HTTPException, status
from authlib.integrations.httpx_client import AsyncOAuth2Client
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from jose import jwt
from datetime import datetime, timedelta
from pydantic import BaseModel

from app.config import get_settings
from app.db.database import get_db
from app.db.models import User
from app.api.dependencies import get_current_user

router = APIRouter()
settings = get_settings()

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"
SCOPES = [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/drive.readonly",
]


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


def create_jwt_token(user_id: str) -> str:
    expire = datetime.utcnow() + timedelta(hours=settings.jwt_expiration_hours)
    payload = {"sub": user_id, "exp": expire}
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


@router.get("/login")
async def login():
    client = AsyncOAuth2Client(
        client_id=settings.google_client_id,
        client_secret=settings.google_client_secret,
        redirect_uri=f"{settings.frontend_url}/auth/callback",
        scope=" ".join(SCOPES),
    )
    uri, _ = client.create_authorization_url(GOOGLE_AUTH_URL, access_type="offline", prompt="consent")
    return {"auth_url": uri}


@router.post("/callback", response_model=TokenResponse)
async def callback(code: str, db: AsyncSession = Depends(get_db)):
    client = AsyncOAuth2Client(
        client_id=settings.google_client_id,
        client_secret=settings.google_client_secret,
        redirect_uri=f"{settings.frontend_url}/auth/callback",
    )
    
    try:
        token = await client.fetch_token(GOOGLE_TOKEN_URL, code=code)
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid authorization code")
    
    client.token = token
    resp = await client.get(GOOGLE_USERINFO_URL)
    userinfo = resp.json()
    
    result = await db.execute(select(User).where(User.google_id == userinfo["id"]))
    user = result.scalar_one_or_none()
    
    if user:
        user.refresh_token = token.get("refresh_token", user.refresh_token)
        user.last_login = datetime.utcnow()
    else:
        user = User(
            email=userinfo["email"],
            google_id=userinfo["id"],
            name=userinfo.get("name", userinfo["email"]),
            refresh_token=token.get("refresh_token"),
        )
        db.add(user)
    
    await db.commit()
    await db.refresh(user)
    
    access_token = create_jwt_token(str(user.id))
    return TokenResponse(access_token=access_token)


@router.get("/me")
async def get_me(user: User = Depends(get_current_user)):
    return {"id": str(user.id), "email": user.email, "name": user.name}
