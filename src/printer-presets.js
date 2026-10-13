import catalog from './printer-presets.json' with {type:'json'};

export const BAMBU_PRINTER_CATALOG = Object.freeze(catalog);
export const DEFAULT_BAMBU_PRINTER_MODEL_ID = catalog.defaultPrinterModelId;
export const BAMBU_PRINTER_MODELS = Object.freeze(catalog.models.map(model=>Object.freeze({
  ...model,
  nozzleDiameterMm:0.4,
})));
export const BAMBU_PRINTER_MODEL_BY_ID = Object.freeze(Object.fromEntries(BAMBU_PRINTER_MODELS.map(model=>[model.id,model])));
export function isBambuPrinterModel(value){return Object.hasOwn(BAMBU_PRINTER_MODEL_BY_ID,String(value||''));}
export function getBambuPrinterModel(value){return BAMBU_PRINTER_MODEL_BY_ID[String(value||'')]||null;}
