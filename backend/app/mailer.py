import logging
import smtplib
from email.message import EmailMessage

from .config import get_settings

log = logging.getLogger(__name__)


def mail_enabled() -> bool:
    return bool(get_settings().smtp_host)


def send_mail(to: str, subject: str, body: str) -> bool:
    s = get_settings()
    if not s.smtp_host:
        return False
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = s.smtp_from, to, subject
    msg.set_content(body)
    try:
        with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=15) as smtp:
            smtp.starttls()
            if s.smtp_user:
                smtp.login(s.smtp_user, s.smtp_password or "")
            smtp.send_message(msg)
        return True
    except Exception:  # noqa: BLE001
        log.exception("mail delivery failed")
        return False
