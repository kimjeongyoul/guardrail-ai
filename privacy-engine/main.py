from fastapi import FastAPI
from pydantic import BaseModel
from presidio_analyzer import AnalyzerEngine
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig
from sentence_transformers import SentenceTransformer

app = FastAPI()

# Initialize Presidio engines
analyzer = AnalyzerEngine()
anonymizer = AnonymizerEngine()

# Initialize Embedding model (Lightweight and fast)
embed_model = SentenceTransformer('all-MiniLM-L6-v2')

class Content(BaseModel):
    text: str

@app.get("/health")
def health():
    return {"status": "OK", "service": "Privacy Engine", "engine": "Presidio + SentenceTransformers"}

@app.post("/mask")
async def mask_content(content: Content):
    # (기존 마스킹 로직 유지)
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
    
    return {
        "original": content.text, 
        "masked": anonymized_result.text,
        "items_found": len(results)
    }

@app.post("/embed")
async def get_embedding(content: Content):
    # Generate vector embedding for the text
    vector = embed_model.encode(content.text).tolist()
    return {"embedding": vector}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
