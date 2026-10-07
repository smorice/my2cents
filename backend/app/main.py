import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import bootstrap
from .config import get_settings
from .deps import csrf_guard
from .observability import new_request_id, record_error, request_id_var, setup_logging, user_id_var
from .routers import admin, auth, backtests, jobs, market, portfolios, strategies, system

setup_logging()
log = logging.getLogger("app.http")
settings = get_settings()
BASE = settings.base_path.rstrip("/")


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Long-running work (backtests, market data refresh) lives in the worker process.
    bootstrap.prepare()
    yield


app = FastAPI(title="My2cents", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=f"{BASE}/api/openapi.json")

api = APIRouter(prefix=f"{BASE}/api", dependencies=[Depends(csrf_guard)])
for r in (auth.router, admin.router, strategies.router, backtests.router, portfolios.router, market.router, jobs.router, system.router):
    api.include_router(r)


@api.get("/health")
def health():
    return {"status": "ok"}


@api.api_route("/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"], include_in_schema=False)
def api_not_found(rest: str):
    raise HTTPException(404, "Route inconnue")


app.include_router(api)

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
    "font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'"
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    rid = new_request_id()
    request_id_var.set(rid)
    user_id_var.set(None)
    started = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception as exc:  # noqa: BLE001 - last resort: never leak internals to the client
        ref = record_error(exc, source="api", method=request.method, path=request.url.path, request_id=rid,
                           user_id=getattr(request.state, "user_id", None))
        response = JSONResponse(status_code=500, content={
            "detail": f"Erreur interne inattendue. Référence : {ref}. L'administrateur a été informé.", "ref": ref})
    if request.url.path.startswith(f"{BASE}/api"):
        log.info("request", extra={
            "method": request.method, "path": request.url.path, "status": response.status_code,
            "duration_ms": round((time.perf_counter() - started) * 1000, 1), "user_id": getattr(request.state, "user_id", None),
        })
    response.headers["X-Request-ID"] = rid
    response.headers.setdefault("Content-Security-Policy", CSP)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    if request.url.path.startswith(f"{BASE}/api"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(ValueError)
async def value_error(_: Request, exc: ValueError):
    return JSONResponse(status_code=422, content={"detail": str(exc)})


static = Path(settings.static_dir)
if static.exists():
    app.mount(f"{BASE}/assets", StaticFiles(directory=static / "assets"), name="assets")

    @app.get(BASE, include_in_schema=False)
    @app.get(BASE + "/{path:path}", include_in_schema=False)
    def spa(path: str = ""):
        f = (static / path).resolve()
        if path and f.is_file() and static.resolve() in f.parents:
            return FileResponse(f)
        return FileResponse(static / "index.html", headers={"Cache-Control": "no-cache"})
