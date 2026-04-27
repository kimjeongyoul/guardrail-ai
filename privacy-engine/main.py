from fastapi import FastAPI, Request
from pydantic import BaseModel
from presidio_analyzer import AnalyzerEngine
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig
from sentence_transformers import SentenceTransformer
import logging

# Configure logging to include Trace ID
logging.basicConfig(level=logging.INFO, format='%(levelname)s: [%(trace_id)s] %(message)s')
logger = logging.getLogger("privacy-engine")

app = FastAPI()

# Initialize engines
analyzer = AnalyzerEngine()
anonymizer = AnonymizerEngine()
embed_model = SentenceTransformer('all-MiniLM-L6-v2')

class Content(BaseModel):
    text: str

@app.post("/mask")
async def mask_content(content: Content, request: Request):
    trace_id = request.headers.get("X-Trace-ID", "unknown")
    extra = {"trace_id": trace_id}
    
    logger.info(f"PII Masking initiated for content length: {len(content.text)}", extra=extra)
    
    results = analyzer.analyze(text=content.text, language='en', 
                               entities=["PHONE_NUMBER", "EMAIL_ADDRESS", "PERSON", "LOCATION", "URL"])
    
    operators = {
        "DEFAULT": OperatorConfig("replace", {"new_value": "<MASKED>"}),
    }
    
    anonymized_result = anonymizer.anonymize(
        text=content.text,
        analyzer_results=results,
        operators=operators
    )
    
    logger.info(f"PII Masking completed. Items found: {len(results)}", extra=extra)
    
    return {
        "masked": anonymized_result.text,
        "items_found": len(results)
    }

@app.post("/embed")
async def get_embedding(content: Content, request: Request):
    trace_id = request.headers.get("X-Trace-ID", "unknown")
    extra = {"trace_id": trace_id}
    
    logger.info("Generating embedding vector...", extra=extra)
    vector = embed_model.encode(content.text).tolist()
    return {"embedding": vector}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
