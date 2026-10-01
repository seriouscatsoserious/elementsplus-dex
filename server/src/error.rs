//! API error type. Every failure leaves the server as
//! `{"error": {"code": "<stable_snake_case>", "message": "..."}}` with an
//! appropriate status code; internal details are logged, never returned.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    /// Logged but not returned (internal/upstream failures).
    pub detail: Option<String>,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ApiError {}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            detail: None,
        }
    }

    pub fn bad(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    pub fn not_found(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, code, message)
    }

    pub fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, message)
    }

    pub fn too_large() -> Self {
        Self::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            "request body too large",
        )
    }

    pub fn upstream(detail: impl std::fmt::Display) -> Self {
        Self {
            detail: Some(detail.to_string()),
            ..Self::new(
                StatusCode::BAD_GATEWAY,
                "upstream_error",
                "the block explorer request failed",
            )
        }
    }

    pub fn internal(detail: impl std::fmt::Display) -> Self {
        Self {
            detail: Some(detail.to_string()),
            ..Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "internal error",
            )
        }
    }

    pub fn body(&self) -> serde_json::Value {
        json!({ "error": { "code": self.code, "message": self.message } })
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match (&self.detail, self.status.is_server_error()) {
            (Some(detail), true) => {
                tracing::error!(code = self.code, %detail, "request failed")
            }
            (detail, _) => tracing::debug!(
                code = self.code,
                message = %self.message,
                detail = detail.as_deref().unwrap_or(""),
                "request rejected"
            ),
        }
        (self.status, Json(self.body())).into_response()
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(error: rusqlite::Error) -> Self {
        Self::internal(error)
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
