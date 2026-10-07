import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import current_user
from ..models import Job, User

router = APIRouter(prefix="/jobs", tags=["jobs"])


def job_out(job: Job, admin: bool = False) -> dict:
    out = {
        "id": str(job.id), "kind": job.kind, "status": job.status, "progress": job.progress, "message": job.message,
        "error": job.user_error, "attempts": job.attempts, "created_at": job.created_at,
        "started_at": job.started_at, "finished_at": job.finished_at,
    }
    if admin:
        out.update(owner_id=str(job.owner_id) if job.owner_id else None, worker=job.worker, payload=job.payload,
                   internal_error=job.error, heartbeat_at=job.heartbeat_at)
    return out


@router.get("/{job_id}")
def get_job(job_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)):
    job = db.get(Job, job_id)
    if job is None or job.owner_id != user.id:
        raise HTTPException(404, "Tâche introuvable")
    return job_out(job)
