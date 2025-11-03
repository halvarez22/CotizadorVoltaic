export type PyInputs = {
  consumo_kwh_mensual?: number;
  demanda_kw?: number;
  tarifa_cfe?: 'OM' | 'HM' | 'PDBT' | 'GDMTH' | 'Otro';
  costo_total_actual?: number;
  costo_energia_kwh?: number;
  costo_demanda_kw?: number;
  dias_facturados?: number;
  periodo_facturacion?: string;
  kWp: number;
  performance_ratio?: number;
  degradacion_solar_anual?: number;
  capex?: number | null;
  opex_anual?: number;
  vida_proyecto_anos?: number;
  tasa_descuento?: number;
  inflacion_om?: number;
  tasa_actualizacion_tarifa_anual?: number;
  modo?: 'CAPEX' | 'PPA';
  costo_ppa_inicial?: number | null;
  escalador_ppa_anual?: number;
  moneda?: 'MXN' | 'USD' | 'EUR';
  irradiacion_mensual?: number[];
};

export async function calculateWithPython(inputs: PyInputs) {
  const baseUrl = (import.meta as any).env?.VITE_PY_ENGINE_URL;
  if (!baseUrl) throw new Error('VITE_PY_ENGINE_URL no configurado');
  
  console.log('📤 Enviando a Python engine:', { url: baseUrl, payload: inputs });
  
  // Crear AbortController para timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 90000); // 90 segundos timeout (para dar tiempo al cold start de Render)
  
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/calculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(inputs),
      signal: controller.signal, // Agregar signal para timeout
    });
    
    clearTimeout(timeoutId); // Cancelar timeout si llegó respuesta
    
    console.log('📥 Respuesta del servidor:', { status: res.status, ok: res.ok });
    
    if (!res.ok) {
      const errorText = await res.text();
      console.error('❌ Error del servidor Python:', errorText);
      throw new Error(`Python engine error ${res.status}: ${errorText}`);
    }
    
    const data = await res.json();
    console.log('✅ Datos recibidos del motor Python:', data);
    return data;
  } catch (error: any) {
    clearTimeout(timeoutId); // Asegurar limpieza del timeout
    console.error('❌ Error en calculateWithPython:', error);
    
    // Mejorar mensaje de error para timeout
    if (error.name === 'AbortError') {
      throw new Error('Timeout: El servidor Python tardó demasiado en responder. Esto puede ocurrir si el servicio está "dormido" en Render (plan gratuito). Intenta de nuevo en unos segundos.');
    }
    
    // Error de red
    if (error.message?.includes('Failed to fetch') || error.message?.includes('NetworkError')) {
      throw new Error('Error de conexión: No se pudo conectar al servidor Python. Verifica que el servicio esté disponible en Render.');
    }
    
    throw error;
  }
}


