# AI-EVAL OpenCV Scanner - Production Web Service Container
FROM python:3.11-slim

# Prevent Python from writing pyc files and buffer stdout
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000

# Install required system libraries for image processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency specification first for Docker layer caching
COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt gunicorn

# Copy all scanner modules and pipeline phases
COPY . .

EXPOSE 8000

# Healthcheck to monitor microservice availability
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request, os; urllib.request.urlopen('http://localhost:' + str(os.environ.get('PORT', 8000)) + '/health')" || exit 1

# Production WSGI startup via Gunicorn
CMD ["sh", "-c", "exec gunicorn --workers 2 --threads 2 --timeout 60 --bind 0.0.0.0:$PORT server:app"]
