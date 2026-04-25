from fastapi import FastAPI
from pydantic import BaseModel
from presidio_analyzer import AnalyzerEngine
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig

app = FastAPI()

# Initialize Presidio engines
analyzer = AnalyzerEngine()
anonymizer = AnonymizerEngine()

class Content(BaseModel):
    text: str

@app.get("/health")
def health():
    return {"status": "OK", "service": "Privacy Engine", "engine": "Presidio"}

@app.post("/mask")
async def mask_content(content: Content):
    # 1. Analyze text for PII
    results = analyzer.analyze(text=content.text, language='en', 
                               entities=["PHONE_NUMBER", "EMAIL_ADDRESS", "PERSON", "LOCATION", "URL"])
    
    # 2. Anonymize/Mask the identified PII
    # We can customize operators, e.g., replace with <MASKED_ENTITY_TYPE>
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

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
