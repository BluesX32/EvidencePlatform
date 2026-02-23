from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str
    secret_key: str
    access_token_expire_hours: int = 24
    backend_cors_origins: str = "http://localhost:5173"

    model_config = {"env_file": "../.env", "env_file_encoding": "utf-8"}

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.backend_cors_origins.split(",")]


settings = Settings()
