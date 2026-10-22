import { measure, type Scale, type MeasurementResult } from './measurements.ts';
import { validateTakeoff, type TakeoffState } from './takeoff.ts';

export type CalibrationImpact = {id:string; label:string; before:MeasurementResult; after:MeasurementResult; beforeEvidence?:Scale; afterEvidence?:Scale};

/** Reject invalid candidates before approval; include evidence changes even if the quantity is equal. */
export function reviewCalibrationChange(input:TakeoffState, scales:Scale[], pageCount:number): {candidate:TakeoffState; impacts:CalibrationImpact[]} {
  const before = validateTakeoff(input,pageCount);
  const candidate = validateTakeoff({scales,records:before.records},pageCount);
  const impacts:CalibrationImpact[]=[];
  for(const record of before.records) {
    const previous=measure({...record,scales:before.scales});
    const next=measure({...record,scales:candidate.scales});
    const oldScale=before.scales.find(scale=>scale.id===previous.scaleId);
    const newScale=candidate.scales.find(scale=>scale.id===next.scaleId);
    if(previous.value!==next.value || previous.unit!==next.unit || JSON.stringify(oldScale)!==JSON.stringify(newScale))
      impacts.push({id:record.id,label:record.label,before:previous,after:next,beforeEvidence:oldScale,afterEvidence:newScale});
  }
  return {candidate,impacts};
}
