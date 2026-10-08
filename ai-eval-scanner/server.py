"""
ai-eval-scanner/server.py

Lightweight HTTP microservice exposing the AI-EVAL computer vision pipeline
to Shiva's EvalNexa frontend Control Center and backend ingestion services.

Endpoints:
- GET  /health        -> Health check (fast status ping, < 50ms)
- POST /process-page  -> Page image analysis, deskew, quality assessment, and OCR readiness

Port: 8000 (configurable via PORT environment variable)
CORS: Fully enabled for cross-origin browser requests (localhost:5173, etc.)
"""

from __future__ import annotations

import os
import sys
import logging
from typing import Any, Dict

from flask import Flask, request, jsonify

# Ensure local scanner modules are importable
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

from pipeline import process_image
import cv2
import numpy as np
from document_scanner import (
    detect_document_quad,
    warp_perspective,
    validate_document_substrate_and_content,
    compute_sharpness_metrics,
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("ai_eval_scanner")

app = Flask(__name__)

# ---------------------------------------------------------------------------
# CORS Configuration (Supports https://control.shivasoni.me, local dev, and wildcard)
# ---------------------------------------------------------------------------
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "ALLOWED_ORIGINS",
        "https://control.shivasoni.me,http://localhost:5173,http://localhost:3000,*",
    ).split(",")
    if o.strip()
]


@app.after_request
def apply_cors_headers(response):
    origin = request.headers.get("Origin")
    if origin and any(origin == o for o in ALLOWED_ORIGINS if o != "*"):
        response.headers["Access-Control-Allow-Origin"] = origin
    else:
        response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = (
        "Content-Type, Authorization, X-INGESTION-KEY, X-API-KEY"
    )
    response.headers["Access-Control-Max-Age"] = "86400"
    return response


# ---------------------------------------------------------------------------
# Health Check Endpoint: GET /health
# ---------------------------------------------------------------------------
@app.route("/health", methods=["GET", "OPTIONS"])
def health_check():
    """
    Returns predictable JSON indicating scanner service availability.
    Consumed by apps/control-center/src/lib/scanningIntegration.ts:checkScanningServiceHealth()
    """
    if request.method == "OPTIONS":
        return ("", 204)
    return jsonify({
        "status": "ok",
        "service": "AI-EVAL-OpenCV Scanner Service",
        "version": "1.0.0",
    }), 200


# ---------------------------------------------------------------------------
# Lightweight Document Detection Endpoint: POST /detect-document
# ---------------------------------------------------------------------------
@app.route("/detect-document", methods=["POST", "OPTIONS"])
def handle_detect_document():
    """
    Lightweight document detection endpoint for live camera preview (5-10 FPS).
    Performs boundary and quadrilateral detection without downstream OCR or full
    defect triage matrices.

    Input:
    - multipart/form-data with 'file', OR raw image binary in request body.

    Output JSON:
    {
        "detected": bool,
        "corners": [[x1, y1], [x2, y2], [x3, y3], [x4, y4]] | None,
        "document_score": float (0-100),
        "image_width": int,
        "image_height": int,
        "reason": str
    }
    """
    if request.method == "OPTIONS":
        return ("", 204)

    try:
        if "file" in request.files:
            file_obj = request.files["file"]
            img_bytes = file_obj.read()
        else:
            img_bytes = request.get_data()

        if not img_bytes or len(img_bytes) < 16:
            return jsonify({
                "detected": False,
                "corners": None,
                "document_score": 0.0,
                "reason": "Empty frame payload",
            }), 400

        nparr = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None or img.size == 0:
            return jsonify({
                "detected": False,
                "corners": None,
                "document_score": 0.0,
                "reason": "Failed to decode frame",
            }), 400

        h, w = img.shape[:2]
        quad = detect_document_quad(img)

        if quad is None:
            return jsonify({
                "detected": False,
                "corners": None,
                "document_score": 0.0,
                "image_width": w,
                "image_height": h,
                "reason": "No document detected",
            }), 200

        corners_list = [[float(pt[0]), float(pt[1])] for pt in quad["corners"]]

        # Quick substrate check to reject dark notebook covers or blank surfaces
        try:
            warped, _, _ = warp_perspective(img, quad["corners"])
            is_valid, _, rej_msg = validate_document_substrate_and_content(warped)
            if not is_valid:
                return jsonify({
                    "detected": False,
                    "corners": None,
                    "document_score": 15.0,
                    "image_width": w,
                    "image_height": h,
                    "reason": rej_msg,
                }), 200

            _, sharpness_score, _ = compute_sharpness_metrics(warped)
        except Exception:
            sharpness_score = 75.0

        return jsonify({
            "detected": True,
            "corners": corners_list,
            "document_score": round(float(sharpness_score), 1),
            "area_ratio": round(float(quad["area_ratio"]), 3),
            "aspect_ratio": round(float(quad["aspect_ratio"]), 3),
            "image_width": w,
            "image_height": h,
            "reason": "Document detected",
        }), 200

    except Exception as e:
        logger.error(f"Error in /detect-document: {e}", exc_info=True)
        return jsonify({
            "detected": False,
            "corners": None,
            "document_score": 0.0,
            "reason": "Detection error",
        }), 500


# ---------------------------------------------------------------------------
# Page Processing Endpoint: POST /process-page
# ---------------------------------------------------------------------------
@app.route("/process-page", methods=["POST", "OPTIONS"])
def handle_process_page():
    """
    Accepts multipart/form-data with:
    - file: Binary image file (required)
    - pageNumber: String or int (required)
    - examId: String (optional)
    - answerBookCode: String (optional)

    Returns JSON conforming to EvalNexa's ProcessPageResult interface.
    """
    if request.method == "OPTIONS":
        return ("", 204)

    # 1. Validate 'file' presence
    if "file" not in request.files:
        logger.warning("Rejected /process-page: Missing 'file' form field")
        return jsonify({
            "status": "error",
            "message": "Missing required 'file' field in multipart payload",
        }), 400

    file_obj = request.files["file"]
    if not file_obj or file_obj.filename == "":
        logger.warning("Rejected /process-page: Empty filename or file object")
        return jsonify({
            "status": "error",
            "message": "Provided file is empty",
        }), 400

    # 2. Extract metadata fields
    page_num_str = request.form.get("pageNumber", "1")
    exam_id = request.form.get("examId", "default_exam")
    answer_book_code = request.form.get("answerBookCode", "PENDING")
    corners_raw = request.form.get("corners")
    orig_corners_raw = request.form.get("original_corners")
    preview_w_raw = request.form.get("previewWidth")
    preview_h_raw = request.form.get("previewHeight")
    capture_w_raw = request.form.get("captureWidth")
    capture_h_raw = request.form.get("captureHeight")

    corners_hint = None
    if corners_raw:
        try:
            import json
            parsed = json.loads(corners_raw)
            if isinstance(parsed, list) and len(parsed) == 4:
                corners_hint = parsed
        except Exception:
            corners_hint = None

    orig_corners = None
    if orig_corners_raw:
        try:
            import json
            parsed_orig = json.loads(orig_corners_raw)
            if isinstance(parsed_orig, list) and len(parsed_orig) == 4:
                orig_corners = parsed_orig
        except Exception:
            orig_corners = None

    preview_width = int(preview_w_raw) if preview_w_raw and preview_w_raw.isdigit() else None
    preview_height = int(preview_h_raw) if preview_h_raw and preview_h_raw.isdigit() else None
    capture_width = int(capture_w_raw) if capture_w_raw and capture_w_raw.isdigit() else None
    capture_height = int(capture_h_raw) if capture_h_raw and capture_h_raw.isdigit() else None

    try:
        page_number = int(page_num_str)
    except (ValueError, TypeError):
        page_number = 1

    doc_id = f"{answer_book_code}_pg{page_number}"
    logger.info(
        f"Processing page: doc_id={doc_id}, exam_id={exam_id}, filename={file_obj.filename}, "
        f"corners_hint_present={corners_hint is not None}, preview_dim={preview_width}x{preview_height}"
    )

    # 3. Read raw image bytes
    try:
        image_bytes = file_obj.read()
        if len(image_bytes) < 16:
            return jsonify({
                "status": "error",
                "message": "Image payload is empty or too small",
            }), 400
    except Exception as e:
        logger.error(f"Failed to read image stream: {e}")
        return jsonify({
            "status": "error",
            "message": "Failed to read image byte stream",
        }), 400

    # 4. Execute AI-EVAL Computer Vision Pipeline
    try:
        diagnostics = process_image(
            image_input=image_bytes,
            document_id=doc_id,
            page_number=page_number,
            exam_id=exam_id,
            answer_book_code=answer_book_code,
            corners_hint=corners_hint,
            original_corners=orig_corners,
            preview_width=preview_width,
            preview_height=preview_height,
            capture_width=capture_width,
            capture_height=capture_height,
        )

        logger.info(
            f"Successfully processed {doc_id}: "
            f"status={diagnostics['qualityStatus']}, "
            f"sharpness={diagnostics['sharpness']}, "
            f"cropReady={diagnostics.get('cropReady')}, "
            f"source={diagnostics.get('source_width')}x{diagnostics.get('source_height')}, "
            f"output={diagnostics.get('output_width')}x{diagnostics.get('output_height')}"
        )

        # Return JSON directly compatible with ProcessPageResult in scanningIntegration.ts
        return jsonify(diagnostics), 200

    except ValueError as val_err:
        logger.warning(f"Validation error processing {doc_id}: {val_err}")
        return jsonify({
            "status": "error",
            "message": str(val_err),
        }), 400

    except Exception as err:
        logger.error(f"Internal error processing {doc_id}: {err}", exc_info=True)
        # Never expose Python stack traces or filesystem paths to client
        return jsonify({
            "status": "error",
            "message": "Image processing pipeline error occurred",
        }), 500


def main():
    port = int(os.environ.get("PORT", "8000"))
    host = os.environ.get("HOST", "0.0.0.0")
    logger.info("=" * 70)
    logger.info(f"Starting AI-EVAL Scanner Service on http://{host}:{port}")
    logger.info("Endpoints: GET /health | POST /process-page")
    logger.info("=" * 70)
    app.run(host=host, port=port, debug=False)


if __name__ == "__main__":
    main()
