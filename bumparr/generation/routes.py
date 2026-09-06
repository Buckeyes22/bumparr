"""HTTP surface for durable generation. Mounted from app.py."""
from typing import Literal, Optional

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from bumparr.generation import service
from bumparr.generation.service import GenerationError

router = APIRouter()
BODY_CEILING = 128 * 1024


class GenerationBodyLimit:
    """Bound actual bytes before FastAPI/JSON parsing, including chunked bodies."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if (scope["type"] != "http" or not scope.get("path", "").startswith("/api/generation/")
                or scope["method"] not in ("POST", "PUT", "PATCH", "DELETE")):
            return await self.app(scope, receive, send)
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            if len(body) + len(chunk) > BODY_CEILING:
                response = JSONResponse({"error": "invalid_request", "message": "request body exceeds 128 KiB"},
                                        status_code=413)
                return await response(scope, receive, send)
            body.extend(chunk)
            if not message.get("more_body", False):
                break
        delivered = False

        async def replay():
            nonlocal delivered
            if delivered:
                return await receive()
            delivered = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}

        await self.app(scope, replay, send)


class CreativeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    roles: Optional[list[str]] = None
    energy: Optional[str] = None


class GenerationIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: str = Field(..., max_length=80)
    output: str = Field("video", max_length=20)
    mode: str = Field("text", max_length=32)
    prompt: str = Field(..., min_length=1, max_length=8000)
    title: Optional[str] = Field(None, max_length=120)
    kind: str = Field("generated_short", max_length=64)
    duration: Optional[int] = Field(None, ge=1, le=120)
    resolution: Optional[str] = Field(None, max_length=32)
    ratio: str = Field("16:9", max_length=16)
    creative: Optional[CreativeIn] = None


class ReconcileIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider_job_id: Optional[str] = Field(None, max_length=128)
    not_accepted: bool = False


class CreateIn(GenerationIn):
    preflight_token: Optional[str] = Field(None, min_length=64, max_length=64)


class RejectIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: Optional[str] = Field("", max_length=200)


class RegenerateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prompt: Optional[str] = Field(None, max_length=8000)
    title: Optional[str] = Field(None, max_length=120)
    preflight_token: Optional[str] = Field(None, min_length=64, max_length=64)


def _err(exc: GenerationError):
    return JSONResponse({"error": exc.code, "message": exc.message}, status_code=exc.http)


def _body(model):
    data = model.model_dump(exclude_none=True)
    if "creative" in data and data["creative"] is not None:
        data["creative"] = model.creative.model_dump(exclude_none=True) if model.creative else None
    return data


@router.get("/api/generation")
def generation_status():
    return service.public_status()


@router.get("/api/generation/models")
def generation_models():
    return {"models": service.list_models()}


@router.post("/api/generation/preflight")
def generation_preflight(payload: GenerationIn):
    try:
        return service.preflight(_body(payload))
    except GenerationError as exc:
        return _err(exc)


@router.get("/api/generation/jobs")
def generation_jobs(status: Optional[str] = Query(None, max_length=40),
                    provider: Optional[str] = Query(None, max_length=40),
                    limit: int = Query(50, ge=1, le=100),
                    offset: int = Query(0, ge=0)):
    return {"jobs": service.list_jobs(status=status, provider=provider,
                                      limit=limit, offset=offset)}


@router.post("/api/generation/jobs", status_code=202)
def generation_create(payload: CreateIn):
    try:
        body = _body(payload)
        token = body.pop("preflight_token", None)
        job = service.enqueue(body, expected_preflight=token, require_preflight=True)
        return JSONResponse(job, status_code=202)
    except GenerationError as exc:
        return _err(exc)


@router.get("/api/generation/jobs/{job_id}")
def generation_job(job_id: str):
    try:
        return service.get_job(job_id)
    except GenerationError as exc:
        return _err(exc)


@router.post("/api/generation/jobs/{job_id}/cancel")
def generation_cancel(job_id: str):
    try:
        return service.cancel_job(job_id)
    except GenerationError as exc:
        return _err(exc)


@router.post("/api/generation/jobs/{job_id}/regenerate")
def generation_regenerate(job_id: str, payload: Optional[RegenerateIn] = None):
    try:
        body = payload.model_dump(exclude_none=True) if payload else {}
        job = service.regenerate(job_id, body, require_preflight=True)
        return JSONResponse(job, status_code=202)
    except GenerationError as exc:
        return _err(exc)


@router.post("/api/generation/jobs/{job_id}/reconcile")
def generation_reconcile(job_id: str, payload: ReconcileIn):
    try:
        return service.reconcile(job_id, payload.model_dump())
    except GenerationError as exc:
        return _err(exc)


@router.get("/api/generation/outputs")
def generation_outputs(review_status: Literal["pending", "approved", "rejected", "deleted"] = "pending",
                       limit: int = Query(50, ge=1, le=100),
                       offset: int = Query(0, ge=0)):
    return {"outputs": service.list_outputs(review_status=review_status,
                                            limit=limit, offset=offset)}


@router.post("/api/generation/outputs/{output_id}/approve")
def generation_approve(output_id: str):
    try:
        return service.approve_output(output_id)
    except GenerationError as exc:
        return _err(exc)


@router.post("/api/generation/outputs/{output_id}/reject")
def generation_reject(output_id: str, payload: Optional[RejectIn] = None):
    try:
        reason = payload.reason if payload else ""
        return service.reject_output(output_id, reason or "")
    except GenerationError as exc:
        return _err(exc)


@router.post("/api/generation/outputs/{output_id}/retry-processing")
def generation_retry(output_id: str):
    try:
        return service.retry_processing(output_id)
    except GenerationError as exc:
        return _err(exc)


@router.delete("/api/generation/outputs/{output_id}")
def generation_delete_output(output_id: str):
    try:
        return service.delete_output(output_id)
    except GenerationError as exc:
        return _err(exc)
