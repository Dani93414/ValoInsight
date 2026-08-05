import os
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path

ensure_env_script = Path(__file__).resolve().parent / "scripts" / "ensure_env.py"
if ensure_env_script.exists():
    subprocess.run([sys.executable, str(ensure_env_script)], check=True)

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response
import uvicorn

# 1. Importar routers desde módulos hexagonales
from modules.analytics.interfaces.routes import router as analytics_router
from modules.auth.interfaces.routes import router as auth_router
from modules.content.interfaces.routes import router as content_router
from modules.economy_ml.interfaces.routes import router as economy_ml_router
from modules.leaderboards.interfaces.routes import router as leaderboards_router
from modules.matches.interfaces.routes import router as matches_router
from modules.players.interfaces.routes import router as players_router
from modules.regions.interfaces.routes import router as regions_router
from modules.users.interfaces.routes import router as users_router
from infrastructure.mongo_client import ensure_indexes

load_dotenv()

CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")
    if origin.strip()
]
CORS_ALLOW_CREDENTIALS = "*" not in CORS_ORIGINS


@asynccontextmanager
async def lifespan(_: FastAPI):
    ensure_indexes()
    yield


app = FastAPI(
    title="Valorant API",
    version="1.0.0",
    description="API de contenido, leaderboards, jugadores y regiones de Valorant",
    lifespan=lifespan,
)

# CORS configurable por entorno
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=CORS_ALLOW_CREDENTIALS,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=6)


# ---- Cache-Control middleware ----
# Content rarely changes (only on Riot patches); player data is more dynamic.
_CACHE_RULES: list[tuple[str, str]] = [
    ("/content/", "public, max-age=86400"),       # 24 h for static content
    ("/leaderboards/", "public, max-age=3600"),    # 1 h for leaderboards
    ("/regions/", "no-store"),                      # rebuilt analytics must show immediately
    ("/matches/", "public, max-age=600"),           # 10 min for match list
    ("/players/", "private, no-store"),             # dynamic player metrics
    ("/users/", "private, no-store"),               # private user activity
    ("/analytics/", "private, no-store"),           # dynamic metric/heatmap data
    ("/auth/", "private, no-store"),                # session endpoints
]


class CacheControlMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):  # type: ignore[override]
        response: Response = await call_next(request)
        path = request.url.path
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault("X-Frame-Options", "DENY")
        if request.method == "GET" and response.status_code == 200:
            for prefix, header_value in _CACHE_RULES:
                if path.startswith(prefix):
                    response.headers.setdefault("Cache-Control", header_value)
                    break
        return response


app.add_middleware(CacheControlMiddleware)

# -------------------------
# ROUTERS
# -------------------------
app.include_router(content_router, prefix="/content", tags=["Content"])
app.include_router(leaderboards_router, prefix="/leaderboards", tags=["Leaderboards"])
app.include_router(matches_router, prefix="/matches", tags=["Matches"])
app.include_router(auth_router, prefix="/auth", tags=["Auth"])
app.include_router(users_router, prefix="/users", tags=["Users"])

# 2. Registrar los nuevos routers
app.include_router(players_router, prefix="/players", tags=["Players"])
app.include_router(regions_router, prefix="/regions", tags=["Regions"])
app.include_router(analytics_router, prefix="/analytics", tags=["Analytics"])
app.include_router(economy_ml_router, prefix="/economy-ml", tags=["Economy ML"])

# -------------------------
# ROOT
# -------------------------
@app.get("/")
def root():
    return {
        "status": "ok",
        "endpoints": [
            "/content",
            "/leaderboards",
            "/matches",
            "/players",
            "/regions",
            "/analytics",
            "/auth",
            "/users"
        ]
    }


if __name__ == "__main__":
    host = os.getenv("API_HOST", "0.0.0.0")
    port = int(os.getenv("API_PORT", "8000"))
    uvicorn.run(app, host=host, port=port, reload=False)
