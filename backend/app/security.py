import hashlib
import secrets

import pyotp
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

_hasher = PasswordHasher()

# Pre-computed hash used to keep login timing constant for unknown emails.
_DUMMY_HASH = _hasher.hash("timing-equaliser-not-a-real-password")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerifyMismatchError, InvalidHashError):
        return False


def password_problems(password: str, email: str | None = None) -> list[str]:
    problems = []
    if len(password) < 12:
        problems.append("au moins 12 caractères")
    classes = sum(
        [
            any(c.islower() for c in password),
            any(c.isupper() for c in password),
            any(c.isdigit() for c in password),
            any(not c.isalnum() for c in password),
        ]
    )
    if classes < 3:
        problems.append("au moins 3 types de caractères parmi minuscules, majuscules, chiffres, symboles")
    if email and email.split("@")[0].lower() in password.lower():
        problems.append("ne pas contenir votre identifiant email")
    return problems


def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_totp_secret() -> str:
    return pyotp.random_base32()


def totp_uri(secret: str, email: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name="My2cents")


def verify_totp(secret: str, code: str) -> bool:
    code = (code or "").replace(" ", "")
    return code.isdigit() and pyotp.TOTP(secret).verify(code, valid_window=1)
