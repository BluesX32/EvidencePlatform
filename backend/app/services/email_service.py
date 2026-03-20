from __future__ import annotations

import logging
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import aiosmtplib

from app.config import settings

logger = logging.getLogger(__name__)


async def send_verification_email(to_email: str, name: str, token: str) -> None:
    """Send an email-verification link to a newly registered user.

    If SMTP_HOST is not configured the link is logged at INFO level so
    local development still works without an SMTP server.
    """
    verify_url = f"{settings.frontend_base_url}/verify-email?token={token}"

    if not settings.smtp_host:
        logger.info(
            "SMTP not configured — skipping email send. Verification link for %s: %s",
            to_email,
            verify_url,
        )
        return

    html_body = f"""
    <html><body style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px">
      <h2 style="color:#4f46e5">Verify your EvidencePlatform email</h2>
      <p>Hi {name},</p>
      <p>Thanks for creating an account. Click the button below to confirm your email address:</p>
      <p style="text-align:center;margin:32px 0">
        <a href="{verify_url}"
           style="background:#4f46e5;color:#fff;padding:12px 28px;border-radius:6px;
                  text-decoration:none;font-weight:600;font-size:15px">
          Verify my email
        </a>
      </p>
      <p style="color:#666;font-size:13px">
        Or copy this link into your browser:<br>
        <a href="{verify_url}" style="color:#4f46e5">{verify_url}</a>
      </p>
      <p style="color:#999;font-size:12px">
        This link will remain valid until you use it. If you did not create an account,
        you can safely ignore this email.
      </p>
    </body></html>
    """

    text_body = (
        f"Hi {name},\n\n"
        f"Please verify your EvidencePlatform email by visiting:\n{verify_url}\n\n"
        "If you did not create an account you can ignore this email."
    )

    message = MIMEMultipart("alternative")
    message["From"] = f"{settings.smtp_from_name} <{settings.smtp_from_email}>"
    message["To"] = to_email
    message["Subject"] = "Verify your EvidencePlatform email address"
    message.attach(MIMEText(text_body, "plain"))
    message.attach(MIMEText(html_body, "html"))

    try:
        await aiosmtplib.send(
            message,
            hostname=settings.smtp_host,
            port=settings.smtp_port,
            username=settings.smtp_user or None,
            password=settings.smtp_password or None,
            start_tls=True,
        )
        logger.info("Verification email sent to %s", to_email)
    except Exception:
        # Non-fatal — registration already succeeded.
        logger.exception("Failed to send verification email to %s", to_email)
