FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /srv
COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt
COPY app ./app
COPY tests ./tests
COPY pytest.ini .
RUN chmod -R a+rX /srv && useradd -r -u 10001 zen && mkdir -p /data && chown zen /data
USER zen
EXPOSE 8000
CMD ["uvicorn", "app.main:build_default_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
