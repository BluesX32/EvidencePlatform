from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str
    secret_key: str
    access_token_expire_hours: int = 24
    backend_cors_origins: str = "http://localhost:5173"

    # SMTP / email verification
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from_email: str = "noreply@evidenceplatform.local"
    smtp_from_name: str = "EvidencePlatform"
    # Base URL of the frontend — used to construct the verification link
    frontend_base_url: str = "http://localhost:5173"

    # Optional Semantic Scholar API key — increases rate limit from 1 RPS to 100 RPS.
    # Request a free key at https://www.semanticscholar.org/product/api
    semantic_scholar_api_key: str = ""

    # Absolute path for uploaded PDF storage. Defaults to uploads/ next to the
    # backend/ directory. Override with UPLOADS_DIR=/data/uploads in production
    # so files survive container restarts.
    uploads_dir: str = ""

    # Invite-code system.
    # Set INVITE_REQUIRED=false to allow open registration (e.g. local dev).
    # Set ADMIN_SECRET to a strong random string; required to call admin endpoints
    # that create/list invite codes (POST /auth/admin/invite-codes, etc.).
    invite_required: bool = True
    admin_secret: str = ""

    model_config = {"env_file": "../.env", "env_file_encoding": "utf-8"}

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.backend_cors_origins.split(",")]


settings = Settings()
