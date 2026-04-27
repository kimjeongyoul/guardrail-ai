FROM python:3.12-slim

WORKDIR /app

# Install system dependencies for spacy/presidio if needed
RUN apt-get update && apt-get install -y \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install python dependencies
RUN pip install --no-cache-dir \
    fastapi \
    uvicorn \
    presidio-analyzer \
    presidio-anonymizer \
    spacy \
    sentence-transformers

# Install CPU version of torch separately to keep image slim
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

# Download spacy model
RUN python -m spacy download en_core_web_lg

COPY . .

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
