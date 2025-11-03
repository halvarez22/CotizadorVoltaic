import sys
import os
from pathlib import Path

# Añadir el directorio src al PYTHONPATH
sys.path.insert(0, str(Path(__file__).parent))

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError
import logging
import traceback

from financial_engine import FinancialEngine, FinancialInputs

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Detectar entorno de producción
is_production = os.getenv("ENVIRONMENT") == "production" or os.getenv("RENDER") or os.getenv("RAILWAY_ENVIRONMENT") or os.getenv("K_SERVICE")  # Cloud Run usa K_SERVICE

# Configurar CORS según entorno
if is_production:
    # En producción: especificar dominios explícitos (evita usar "*" con allow_credentials)
    allowed_origins = [
        "https://cotizador-voltaic.vercel.app",  # dominio productivo en Vercel
    ]
    # Permitir previews de Vercel con regex
    allow_origin_regex = r"https://.*\.vercel\.app$"
else:
    # En desarrollo, localhost
    allowed_origins = ["http://localhost:3000", "http://127.0.0.1:3000"]
    allow_origin_regex = None

app = FastAPI(title="Financial Engine API", version="0.1.0")

# Configurar CORS primero, antes de cualquier endpoint
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_origin_regex=allow_origin_regex,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["*"],
)

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Manejar todas las excepciones para asegurar que siempre se devuelvan headers CORS"""
    logger.error(f"❌ Excepción no manejada: {str(exc)}")
    logger.error(f"Traceback: {traceback.format_exc()}")
    return JSONResponse(
        status_code=500,
        content={"error": "InternalError", "message": str(exc), "type": type(exc).__name__},
        headers={"Access-Control-Allow-Origin": "*"}
    )

_engine = FinancialEngine()


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.options("/calculate")
async def options_calculate():
    """Manejar preflight OPTIONS para CORS"""
    return {"status": "ok"}


@app.post("/calculate")
async def calculate(payload: dict):
    try:
        logger.info(f"📥 Recibida petición: {payload}")
        
        # Limpiar el payload de valores None o undefined
        clean_payload = {k: v for k, v in payload.items() if v is not None and v != "undefined"}
        logger.info(f"📋 Payload limpio: {clean_payload}")
        
        inputs = FinancialInputs(**clean_payload)
        logger.info(f"✅ Inputs validados: kWp={inputs.kWp}, modo={inputs.modo}, capex={inputs.capex}")
        
        result = _engine.calculate(inputs)
        logger.info(f"✅ Cálculo completado: VAN={result.kpis.van}, TIR={result.kpis.tir}")
        
        # Serializar y limpiar NaN/Inf a None
        import math
        import json
        
        # Función recursiva para limpiar NaN/Inf
        def clean_nan(obj):
            if isinstance(obj, dict):
                return {k: clean_nan(v) for k, v in obj.items()}
            elif isinstance(obj, list):
                return [clean_nan(item) for item in obj]
            elif isinstance(obj, float):
                if math.isnan(obj) or math.isinf(obj):
                    return None
                return obj
            return obj
        
        # Función para detectar NaN restantes (para logging)
        def has_nan(obj):
            if isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)):
                return True
            if isinstance(obj, dict):
                return any(has_nan(v) for v in obj.values())
            if isinstance(obj, list):
                return any(has_nan(item) for item in obj)
            return False
        
        # Serializar usando mode='json' que debería manejar NaN mejor
        try:
            dumped = result.model_dump(mode='json')
        except Exception as dump_err:
            logger.warning(f"⚠️ model_dump(mode='json') falló: {dump_err}, usando mode por defecto")
            dumped = result.model_dump()
        
        # Limpiar NaN/Inf
        cleaned = clean_nan(dumped)
        
        # Verificar que no hay NaN restantes
        if has_nan(cleaned):
            logger.warning("⚠️ NaN/Inf detectado después de limpieza, limpiando nuevamente...")
            cleaned = clean_nan(cleaned)  # Limpieza adicional
        
        # Validar que se puede serializar a JSON
        try:
            json.dumps(cleaned)
            logger.info(f"✅ Resultado serializado y limpiado, keys: {list(cleaned.keys())[:5]}...")
        except (ValueError, TypeError) as json_err:
            logger.error(f"❌ Error al validar serialización JSON: {json_err}")
            logger.error(f"   Estructura problemática detectada. Reintentando limpieza profunda...")
            # Limpieza más agresiva
            def deep_clean(obj):
                if isinstance(obj, dict):
                    return {k: deep_clean(v) for k, v in obj.items() if v is not None}
                elif isinstance(obj, list):
                    return [deep_clean(item) for item in obj if item is not None]
                elif isinstance(obj, (int, str, bool)):
                    return obj
                elif isinstance(obj, float):
                    if math.isnan(obj) or math.isinf(obj):
                        return None
                    return obj
                elif obj is None:
                    return None
                else:
                    return str(obj)  # Convertir tipos desconocidos a string
            
            cleaned = deep_clean(cleaned)
        
        return cleaned
        
    except ValidationError as e:
        error_msg = str(e)
        logger.error(f"❌ Error de validación: {error_msg}")
        logger.error(f"Errores: {e.errors()}")
        return JSONResponse(
            status_code=422,
            content={"error": "ValidationError", "message": error_msg, "details": e.errors()},
            headers={"Access-Control-Allow-Origin": "*"}
        )
    except Exception as e:
        error_msg = str(e)
        tb = traceback.format_exc()
        logger.error(f"❌ Error en cálculo: {error_msg}")
        logger.error(f"Traceback: {tb}")
        return JSONResponse(
            status_code=500,
            content={"error": "InternalError", "message": error_msg, "traceback": tb},
            headers={"Access-Control-Allow-Origin": "*"}
        )


