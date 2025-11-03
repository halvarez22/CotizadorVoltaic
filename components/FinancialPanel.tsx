import React, { useMemo, useState } from 'react';
import { BillData } from '../types';
import { mapBillToParams } from '../services/financial/mapFromBill';
import { calculateFinancials } from '../services/financial/financialEngine';
import { calculateWithPython } from '../services/financial/pythonEngineService';
import { CurrencyCode, CURRENCIES, convertCurrency, formatCurrency } from '../services/financial/currencyService';
import { generateExcelQuote, generatePDFQuote, QuoteData } from '../services/quote/quoteGenerator';
import DataSection from './DataSection';
import { ChartIcon, DownloadIcon } from './Icons';

const FinancialPanel: React.FC<{ bill: BillData }> = ({ bill }) => {
  const baseParams = useMemo(() => mapBillToParams(bill), [bill]);
  const [currency, setCurrency] = useState<CurrencyCode>('MXN');
  const [kWp, setKWp] = useState<number>(baseParams.kWp || 500);
  // Valores base en MXN (moneda por defecto)
  const [capexMXN, setCapexMXN] = useState<number>(baseParams.capex || 8000000);
  const [opexMXN, setOpexMXN] = useState<number>(baseParams.opexAnual || 80000);
  const [mode, setMode] = useState<'CAPEX' | 'PPA'>(baseParams.modo);
  const [ppa, setPpa] = useState<number>(baseParams.costoPpaInicial || 2.2);
  const [result, setResult] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [engineUsed, setEngineUsed] = useState<'TS' | 'PY' | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Valores convertidos según moneda seleccionada
  const capex = useMemo(() => convertCurrency(capexMXN, 'MXN', currency), [capexMXN, currency]);
  const opex = useMemo(() => convertCurrency(opexMXN, 'MXN', currency), [opexMXN, currency]);

  const run = async () => {
    setErr(null);
    setLoading(true);
    try {
      const params = { ...baseParams, kWp, capex, opexAnual: opex, modo: mode, costoPpaInicial: mode === 'PPA' ? ppa : null } as any;
      const pyUrl = (import.meta as any).env?.VITE_PY_ENGINE_URL;
      if (pyUrl) {
        console.log('🐍 Usando motor Python:', pyUrl);
        setEngineUsed('PY');
        // Warm-up: despertar servicio Render (free) antes de calcular
        try {
          setInfo('Despertando el servicio, puede tardar unos segundos…');
          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), 5000);
          await fetch(`${pyUrl.replace(/\/$/, '')}/health`, { signal: controller.signal });
          clearTimeout(t);
        } catch (_) {
          // Ignorar errores de warm-up; continuar con el cálculo
        }
        // Construir payload eliminando undefined
        const consumoPromedio = bill.historicalConsumption?.reduce((sum, item) => sum + (item.consumptionKWh || 0), 0) / (bill.historicalConsumption?.length || 1);
        const demandaMax = bill.historicalConsumption?.reduce((max, item) => Math.max(max, item.demandKW || 0), 0);
        
        const payload: any = {
          kWp: params.kWp || 500,
          performance_ratio: params.performanceRatio ?? 0.82,
          degradacion_solar_anual: params.degradacionAnual ?? 0.007,
          opex_anual: params.opexAnual ?? 0,
          vida_proyecto_anos: params.vidaProyecto ?? 25,
          tasa_descuento: 0.10,
          inflacion_om: params.inflacionOM ?? 0.03,
          tasa_actualizacion_tarifa_anual: params.escaladoTarifaCfe ?? 0.07,
          modo: params.modo || 'CAPEX',
          escalador_ppa_anual: params.escaladorPpaAnual ?? 0.02,
          tarifa_cfe: 'OM' as const,
          moneda: currency,
        };
        
        // Agregar solo valores definidos
        if (consumoPromedio && consumoPromedio > 0) payload.consumo_kwh_mensual = consumoPromedio;
        if (demandaMax && demandaMax > 0) payload.demanda_kw = demandaMax;
        if (params.modo === 'CAPEX' && capexMXN) {
          // El motor trabaja en MXN internamente, usar valores base
          payload.capex = capexMXN;
        }
        if (params.modo === 'PPA') {
          payload.costo_ppa_inicial = params.costoPpaInicial ?? 2.2;
        }
        // OPEX en MXN (valor base)
        payload.opex_anual = opexMXN;
        console.log('📋 Payload a enviar:', payload);
        const res = await calculateWithPython(payload);
        console.log('✅ Respuesta completa:', res);
        
        if (!res.kpis) {
          throw new Error('La respuesta del motor Python no contiene KPIs');
        }
        
        setResult({
          kpis: {
            van: res.kpis?.van,
            tir: res.kpis?.tir,
            paybackSimple: res.kpis?.payback_simple,
            paybackDescontado: res.kpis?.payback_descontado,
            roi: res.kpis?.roi,
            lcoe: res.kpis?.lcoe,
          },
          projections: res.projections || [],
          cashflow: res.cashflow || [],
          inputs: res.inputs_normalizados || {},
          audit: res.audit || [],
          currency, // Guardar la moneda usada
        });
      } else {
        console.log('⚡ Usando motor TypeScript (fallback)');
        setEngineUsed('TS');
        const res = calculateFinancials(params);
        // Adaptar formato del motor TS al formato esperado
        const projections = res.annualCosts?.map((ac, idx) => ({
          year: idx + 1,
          energia_generada_kwh: res.production?.annual[idx]?.kwh || 0,
          costo_sin_sistema: ac.costoSinSistema,
          costo_con_sistema: ac.costoConSistema,
          ahorro: ac.ahorro,
          opex: ac.opex,
        })) || [];
        
        setResult({
          kpis: {
            van: res.kpis?.van,
            tir: res.kpis?.tir,
            paybackSimple: res.kpis?.paybackSimple,
            paybackDescontado: res.kpis?.paybackDescontado,
            roi: res.kpis?.roi,
            lcoe: res.kpis?.lcoe,
          },
          projections,
          cashflow: res.cashflow || [],
          inputs: res.inputs || {},
          audit: res.audit || [],
          currency,
        });
      }
    } catch (e: any) {
      console.error('❌ Error en run():', e);
      setErr(e?.message || 'Error al calcular');
      setEngineUsed(null);
    } finally {
      setLoading(false);
      setInfo(null);
    }
  };

  return (
    <div className="bg-white/5 backdrop-blur-sm border border-white/10 p-4 sm:p-6 rounded-xl shadow-xl space-y-4">
      <div className="flex items-center justify-between border-b border-white/10 pb-3 mb-3">
        <div className="flex items-center">
          <span className="text-brand-yellow mr-3"><ChartIcon className="w-6 h-6" /></span>
          <h2 className="text-lg font-semibold text-white">Motor Financiero (beta)</h2>
        </div>
        {engineUsed && (
          <span className={`text-xs px-2 py-1 rounded-full ${engineUsed === 'PY' ? 'bg-green-500/20 text-green-400' : 'bg-yellow-500/20 text-yellow-400'}`}>
            {engineUsed === 'PY' ? '🐍 Python' : '⚡ TypeScript'}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        <label className="flex flex-col text-neutral-300">
          Moneda
          <select className="mt-1 bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-white" value={currency} onChange={e => setCurrency(e.target.value as CurrencyCode)}>
            {Object.values(CURRENCIES).map(c => (
              <option key={c.code} value={c.code}>{c.name} ({c.symbol})</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-neutral-300">kWp
          <input className="mt-1 bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-white" type="number" value={kWp} onChange={e => setKWp(Number(e.target.value))} />
        </label>
        <label className="flex flex-col text-neutral-300">
          CAPEX {currency !== 'MXN' && <span className="text-xs text-neutral-400">({CURRENCIES[currency].symbol})</span>}
          <input 
            className="mt-1 bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-white" 
            type="number" 
            value={capex} 
            onChange={e => {
              const newValue = Number(e.target.value);
              setCapexMXN(convertCurrency(newValue, currency, 'MXN'));
            }} 
          />
          {currency !== 'MXN' && (
            <span className="text-xs text-neutral-400 mt-1">
              ≈ {formatCurrency(capexMXN, 'MXN')} base
            </span>
          )}
        </label>
        <label className="flex flex-col text-neutral-300">
          OPEX anual {currency !== 'MXN' && <span className="text-xs text-neutral-400">({CURRENCIES[currency].symbol})</span>}
          <input 
            className="mt-1 bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-white" 
            type="number" 
            value={opex} 
            onChange={e => {
              const newValue = Number(e.target.value);
              setOpexMXN(convertCurrency(newValue, currency, 'MXN'));
            }} 
          />
          {currency !== 'MXN' && (
            <span className="text-xs text-neutral-400 mt-1">
              ≈ {formatCurrency(opexMXN, 'MXN')} base
            </span>
          )}
        </label>
        <label className="flex flex-col text-neutral-300">Modo
          <select className="mt-1 bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-white" value={mode} onChange={e => setMode(e.target.value as any)}>
            <option value="CAPEX">CAPEX</option>
            <option value="PPA">PPA</option>
          </select>
        </label>
        {mode === 'PPA' && (
          <label className="flex flex-col text-neutral-300">Costo PPA inicial ({CURRENCIES[currency].symbol}/kWh)
            <input className="mt-1 bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-white" type="number" step="0.01" value={ppa} onChange={e => setPpa(Number(e.target.value))} />
          </label>
        )}
      </div>

      <div className="flex justify-between items-center">
        <div className="space-y-1">
          {info && <div className="text-xs text-neutral-300">{info}</div>}
          {err && <div className="text-red-400 text-xs">{err}</div>}
        </div>
        <button disabled={loading} onClick={run} className="bg-brand-yellow disabled:opacity-50 text-neutral-950 font-bold px-6 py-2 rounded-full hover:bg-yellow-300 transition-all duration-300">
          {loading ? 'Calculando…' : 'Calcular'}
        </button>
      </div>

      {result && (
        <>
          {/* Botones de descarga */}
          <div className="flex flex-wrap gap-3 justify-end mb-4">
            <button
              onClick={() => {
                const quoteData: QuoteData = {
                  billData: bill,
                  financialResult: result,
                  projectParams: {
                    kWp,
                    capex: capexMXN,
                    opexAnual: opexMXN,
                    modo: mode,
                    costoPpaInicial: mode === 'PPA' ? ppa : undefined,
                    currency: currency,
                  },
                  customerName: bill.customerInfo.find(i => i.key.toUpperCase().includes('NOMBRE'))?.value,
                  serviceNumber: bill.customerInfo.find(i => i.key.includes('NO. DE SERVICIO'))?.value,
                  date: new Date().toLocaleDateString('es-MX'),
                };
                generateExcelQuote(quoteData);
              }}
              className="inline-flex items-center px-4 py-2 bg-green-600 hover:bg-green-700 text-white font-bold rounded-full transition-all duration-300 transform hover:scale-105"
            >
              <DownloadIcon className="w-4 h-4 mr-2" />
              Descargar Excel
            </button>
            <button
              onClick={() => {
                const quoteData: QuoteData = {
                  billData: bill,
                  financialResult: result,
                  projectParams: {
                    kWp,
                    capex: capexMXN,
                    opexAnual: opexMXN,
                    modo: mode,
                    costoPpaInicial: mode === 'PPA' ? ppa : undefined,
                    currency: currency,
                  },
                  customerName: bill.customerInfo.find(i => i.key.toUpperCase().includes('NOMBRE'))?.value,
                  serviceNumber: bill.customerInfo.find(i => i.key.includes('NO. DE SERVICIO'))?.value,
                  date: new Date().toLocaleDateString('es-MX'),
                };
                generatePDFQuote(quoteData);
              }}
              className="inline-flex items-center px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-bold rounded-full transition-all duration-300 transform hover:scale-105"
            >
              <DownloadIcon className="w-4 h-4 mr-2" />
              Descargar PDF
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <DataSection title="KPIs" type="kv" data={[
            { 
              key: 'VAN', 
              value: result.kpis.van != null 
                ? formatCurrency(convertCurrency(result.kpis.van, 'MXN', result.currency || currency), result.currency || currency)
                : 'N/A' 
            },
            { key: 'TIR', value: result.kpis.tir != null ? `${(result.kpis.tir*100).toFixed(2)}%` : 'N/A' },
            { key: 'Payback (años)', value: result.kpis.paybackSimple ?? 'N/A' },
            { key: 'Payback desc (años)', value: result.kpis.paybackDescontado ?? 'N/A' },
            { key: 'ROI', value: result.kpis.roi != null ? `${(result.kpis.roi*100).toFixed(2)}%` : 'N/A' },
            { 
              key: `LCOE (${CURRENCIES[result.currency || currency].symbol}/kWh)`, 
              value: result.kpis.lcoe != null 
                ? formatCurrency(convertCurrency(result.kpis.lcoe, 'MXN', result.currency || currency), result.currency || currency, { minimumFractionDigits: 4, maximumFractionDigits: 4 })
                : 'N/A' 
            },
          ]} />

          <div className="bg-white/5 backdrop-blur-sm border border-white/10 p-4 rounded-xl">
            <h3 className="text-white font-semibold mb-2">Audit log</h3>
            <div className="text-xs text-neutral-300 space-y-1 max-h-48 overflow-auto">
              {result.audit && result.audit.length > 0 ? (
                result.audit.map((l: string, i: number) => (<div key={i}>• {l}</div>))
              ) : (
                <div className="text-neutral-400 italic">Sin mensajes de auditoría</div>
              )}
            </div>
          </div>
          </div>
        </>
      )}
    </div>
  );
};

export default FinancialPanel;


