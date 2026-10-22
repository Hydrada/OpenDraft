import { fillRegion } from './dynamic-fill';
import {sketchEndpoint, calibrateScale, measure, resolveScale, verifyCalibration } from './measurements';
import type { LinearUnit, Point, Rect } from './measurements';
import type { MeasurementRecord, TakeoffState } from './takeoff';
import { reviewCalibrationChange } from './calibration-review';
import { snapPick } from './measurement-snapping';
import type { DrawingVertices } from './drawing-geometry';
import { derivedQuantity, validateQuantityFormula } from './takeoff';
import { loadMeasurementPresets, measurementPresetKey, serializeMeasurementPresets, type MeasurementPreset } from './measurement-presets';

type State = { pageIndex:number; pageBounds:Rect; busy:boolean; takeoff:TakeoffState };
type Callbacks = { getState:()=>State|undefined; commit:(takeoff:TakeoffState)=>Promise<void>; error:(message:string)=>void };
type Viewport = {width:number; height:number; convertToPdfPoint:(x:number,y:number)=>number[]; convertToViewportPoint:(x:number,y:number)=>number[]};
type PickTarget = 'calibrationPoints'|'verificationPoints'|'points';
type Picking = {target:PickTarget; kind:MeasurementRecord['kind']; pageIndex:number; takeoff:TakeoffState; points:Point[]};
const units: LinearUnit[] = ['mm','cm','m','km','in','ft','yd'];
const snapTolerancePixels = 8;
const kinds: MeasurementRecord['kind'][] = ['length','polyline','perimeter','area','angle','count','volume','radius','diameter','arc','space'];

/** Numeric entry uses original, unrotated PDF user coordinates; drawing scale is always reviewed. */
export class MeasurementTools {
  private fields: Record<string,HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement> = {};
  private buttons: HTMLButtonElement[] = [];
  private status: HTMLParagraphElement;
  private scales: HTMLDivElement;
  private list: HTMLDivElement;
  private running = false;
  private fillArmed = false;
  private verificationContext: string | undefined;
  private reviewedPage = -1;
  private reviewedTakeoff: TakeoffState | undefined;
  private verificationTakeoff: TakeoffState | undefined;
  private picking: Picking | undefined;
  private mounted: {frame:HTMLElement; viewport:Viewport; pageIndex:number; overlay:SVGSVGElement; events:AbortController}|undefined;
  private finishButton: HTMLButtonElement;
  private cancelButton: HTMLButtonElement;
  private impactPanel: HTMLDivElement;
  private impactFingerprint: string | undefined;
  private draftScaleId = crypto.randomUUID();
  private presets: MeasurementPreset[] = [];
  private drawing: {pageIndex:number; frame:HTMLElement; vertices:DrawingVertices}|undefined;

  constructor(private container:HTMLElement, private callbacks:Callbacks) {
    container.innerHTML='<h3>Measurements and takeoff</h3><p>Enter unrotated PDF coordinates as x,y pairs separated by semicolons or new lines. Coordinates are not real-world distances. Review a known reference before calibrating; verify another known reference before using quantities.</p>';
    const calibration=this.section('Drawing-scale calibration');
    this.field(calibration,'calibrationPoints','Calibration reference points','textarea','0,0;72,0');
    this.button(calibration,'Pick calibration points',()=>this.beginPicking('calibrationPoints'));
    this.field(calibration,'distance','Known calibration distance','number','');
    this.select(calibration,'calibrationUnit','Calibration unit',units,'ft');
    this.field(calibration,'useViewport','Use calibration viewport','checkbox','');
    this.field(calibration,'viewport','Calibration viewport bounds','text','0,0;200,200');
    this.field(calibration,'reviewed','Review calibration reference','checkbox','');
    const caution=document.createElement('p');
    caution.textContent='Check Review calibration reference only after confirming the stated distance and units against the drawing. Saving a calibration recalculates quantities using that scale. Viewport bounds are lower-left and upper-right coordinate pairs.';
    calibration.append(caution);
    this.button(calibration,'Review calibration impact',()=>this.reviewImpact());
    this.impactPanel=document.createElement('div');
    this.impactPanel.setAttribute('aria-label','Calibration impact review');
    calibration.append(this.impactPanel);
    this.field(calibration,'approveImpact','Approve reviewed quantity changes','checkbox','');
    for(const id of ['calibrationPoints','distance','calibrationUnit','useViewport','viewport']) {
      const invalidate=()=>{this.clearImpact();(this.fields.reviewed as HTMLInputElement).checked=false;};
      this.fields[id].addEventListener('input',invalidate);
      this.fields[id].addEventListener('change',invalidate);
    }
    this.button(calibration,'Save reviewed calibration',()=>this.saveCalibration());
    this.scales=document.createElement('div');
    calibration.append(this.scales);

    const verification=this.section('Independent reference verification');
    this.field(verification,'verificationPoints','Verification reference points','textarea','0,0;144,0');
    this.button(verification,'Pick verification points',()=>this.beginPicking('verificationPoints'));
    this.field(verification,'verificationDistance','Known verification distance','number','');
    this.select(verification,'verificationUnit','Verification unit',units,'ft');
    this.button(verification,'Verify calibration',()=>this.verify());
    const tolerance=document.createElement('p');
    tolerance.textContent='Verification uses 0.1% relative tolerance for the supplied reference only. A passing reference does not certify an entire drawing or engineering quantity.';
    verification.append(tolerance);

    const entry=this.section('Add measurement');
    this.select(entry,'kind','Measurement type',kinds,'length');
    this.field(entry,'label','Measurement label','text','Takeoff');
    this.field(entry,'points','Measurement points','textarea','0,0;72,0');
    this.button(entry,'Pick measurement points',()=>this.beginPicking('points'));
    this.button(entry,'Fill area at a point',()=>{if(!this.mounted)throw new Error('Show a page first.');this.fillArmed=true;this.status.textContent='Click inside the room or region to fill. Lines on the drawing bound the area.';});
    this.field(entry,'fillGap','Fill gap tolerance (pixels)','number','0');
    this.field(entry,'sketchLength','Sketch length (in the measurement unit)','number','');
    this.field(entry,'sketchAngle','Sketch angle (degrees, 0 = right, 90 = up)','number','0');
    this.button(entry,'Sketch to scale from the first point',()=>{
      const state=this.requiredState(),[start]=this.points('points',state.pageBounds);
      const end=sketchEndpoint(state.takeoff.scales,state.pageIndex,start,this.number('sketchLength'),this.fields.unit.value as LinearUnit,Number(this.fields.sketchAngle.value)||0);
      if(end[0]<state.pageBounds[0]||end[0]>state.pageBounds[2]||end[1]<state.pageBounds[1]||end[1]>state.pageBounds[3])throw new Error('The sketched line would run off the page. Shorten it or change the angle.');
      this.fields.kind.value='length';
      this.fields.points.value=[start,end].map(point=>point.map(value=>Math.round(value*1e6)/1e6).join(',')).join(';');
      this.paintOverlay();
      this.status.textContent='Sketched line ready: review it, then use Add measurement.';
    });
    this.field(entry,'cutouts','Area cutouts','textarea','');
    this.select(entry,'unit','Measurement unit',units,'ft');
    this.field(entry,'depth','Volume depth','number','');
    this.select(entry,'depthUnit','Volume depth unit',units,'ft');
    const instructions=document.createElement('p');
    instructions.textContent='Length: two points. Polyline: two or more. Area, perimeter, volume and space: polygon vertices without a repeated closing point. A space is a named room or zone (its label is the name); reports list the space each measurement falls in. Area cutouts: the vertices of each opening, openings separated by |; they are deducted from the area or volume. Angle: three points, middle point is the vertex. Count: one coordinate per item. Volume requires a positive depth.';
    entry.append(instructions);
    this.field(entry,'multiplier','Quantity multiplier','number','');
    this.field(entry,'waste','Waste percent','number','');
    this.field(entry,'derivedUnit','Derived quantity unit','text','');
    const formulaHelp=document.createElement('p');
    formulaHelp.textContent='Optional derived quantity = measured value × multiplier × (1 + waste percent ÷ 100), for example square feet to sheets or cost. Leave the multiplier blank for none. No other formula syntax is evaluated.';
    entry.append(formulaHelp);
    this.button(entry,'Add measurement',()=>this.addMeasurement());
    const presetSection=this.section('Measurement presets');
    const presetRow=document.createElement('label');presetRow.textContent='Measurement preset';
    const presetSelect=document.createElement('select');presetSelect.setAttribute('aria-label','Measurement preset');
    this.fields.preset=presetSelect;presetRow.append(presetSelect);presetSection.append(presetRow);
    this.button(presetSection,'Apply measurement preset',()=>this.applyPreset());
    this.field(presetSection,'presetName','New preset name','text','');
    this.button(presetSection,'Save measurement preset',()=>this.savePreset());
    this.button(presetSection,'Delete measurement preset',()=>this.deletePreset());
    const presetHelp=document.createElement('p');
    presetHelp.textContent='Presets store type, label, unit, depth and derived-quantity settings in this browser. They never store points or calibration, and applying one does not add a measurement.';
    presetSection.append(presetHelp);
    this.status=document.createElement('p');
    this.status.setAttribute('role','status');
    this.status.setAttribute('aria-label','Measurement status');
    container.append(this.status);
    const pickingControls=document.createElement('div');
    this.field(pickingControls,'snap','Snap picks to existing measurement points','checkbox','');
    (this.fields.snap as HTMLInputElement).checked=true;
    this.field(pickingControls,'snapDrawing','Snap picks to drawing endpoints, midpoints and intersections','checkbox','');
    (this.fields.snapDrawing as HTMLInputElement).checked=true;
    this.finishButton=this.button(pickingControls,'Finish picking points',()=>this.finishPicking());
    this.cancelButton=this.button(pickingControls,'Cancel picking points',()=>this.cancelPicking('Point picking cancelled. Existing coordinates are unchanged.'));
    const pickingHelp=document.createElement('p');
    pickingHelp.textContent='Pick points on the sheet to fill a draft coordinate field. References, length, radius and diameter (centre, then a point on the circle) finish after two points; angle and arc (start, a point on the arc, end) after three. Other tools require Finish picking points. Backspace removes the last point; Escape cancels. Review coordinates and use Save reviewed calibration, Verify calibration or Add measurement separately. When enabled, picks within 8 screen pixels of an existing measurement or draft point on this page use that exact point. Hold Shift to constrain a pick horizontally or vertically on screen from the previous draft point. Drawing snapping uses endpoints of painted vector paths, midpoints of straight segments and points where straight segments cross on the rendered page (not curve controls, curve crossings, text, images or markups); geometry on hidden PDF layers is ignored, and very large pages are capped at 50,000 points.';
    pickingControls.append(pickingHelp);container.append(pickingControls);
    this.list=document.createElement('div');
    this.list.setAttribute('aria-label','Measurement records');
    container.append(this.list);
    const loaded=loadMeasurementPresets(localStorage);this.presets=loaded.presets;this.renderPresets();
    if(loaded.error)this.status.textContent=loaded.error;
    this.refresh();
  }

  private renderPresets(selected?:string) {
    const select=this.fields.preset as HTMLSelectElement;
    select.replaceChildren(...this.presets.map(preset=>{const option=document.createElement('option');option.value=preset.name;option.textContent=`${preset.name} (${preset.kind})`;return option;}));
    if(selected)select.value=selected;
  }
  private formula() {
    const raw=this.fields.multiplier.value.trim();
    if(!raw){if(this.fields.waste.value.trim()||this.fields.derivedUnit.value.trim())throw new Error('Enter a quantity multiplier to use waste or a derived unit.');return undefined;}
    return validateQuantityFormula({multiplier:Number(raw),wastePercent:this.fields.waste.value.trim()?Number(this.fields.waste.value):0,unitLabel:this.fields.derivedUnit.value.trim()});
  }
  private storePresets(next:MeasurementPreset[]) {
    const text=serializeMeasurementPresets(next);
    try{localStorage.setItem(measurementPresetKey,text);}catch{throw new Error('Measurement presets could not be saved in this browser. Existing presets are unchanged.');}
    this.presets=next;
  }
  private applyPreset() {
    const preset=this.presets.find(item=>item.name===this.fields.preset.value);
    if(!preset)throw new Error('Select a measurement preset to apply.');
    this.fields.kind.value=preset.kind;this.fields.label.value=preset.label;this.fields.unit.value=preset.unit;
    this.fields.depth.value=preset.depth?String(preset.depth.value):'';if(preset.depth)this.fields.depthUnit.value=preset.depth.unit;
    this.fields.multiplier.value=preset.quantity?String(preset.quantity.multiplier):'';
    this.fields.waste.value=preset.quantity?String(preset.quantity.wastePercent):'';
    this.fields.derivedUnit.value=preset.quantity?.unitLabel??'';
    this.status.textContent=`Preset ${preset.name} applied to the measurement form. No measurement has been added.`;
  }
  private savePreset() {
    const name=this.fields.presetName.value.trim(),kind=this.fields.kind.value as MeasurementRecord['kind'];
    if(!name)throw new Error('Enter a preset name.');
    const preset:MeasurementPreset={name,kind,label:this.fields.label.value.trim()||kind,unit:this.fields.unit.value as LinearUnit};
    if(kind==='volume'&&this.fields.depth.value.trim())preset.depth={value:this.number('depth'),unit:this.fields.depthUnit.value as LinearUnit};
    const quantity=this.formula();if(quantity)preset.quantity=quantity;
    const existing=this.presets.some(item=>item.name.toLowerCase()===name.toLowerCase());
    this.storePresets([...this.presets.filter(item=>item.name.toLowerCase()!==name.toLowerCase()),preset]);
    this.renderPresets(name);
    this.status.textContent=`Preset ${name} ${existing?'replaced':'saved'}.`;
  }
  private deletePreset() {
    const name=this.fields.preset.value;
    if(!this.presets.some(item=>item.name===name))throw new Error('Select a measurement preset to delete.');
    this.storePresets(this.presets.filter(item=>item.name!==name));this.renderPresets();
    this.status.textContent=`Preset ${name} deleted.`;
  }

  private section(title:string) {
    const section=document.createElement('fieldset');
    section.className='markup-form';
    const legend=document.createElement('legend');legend.textContent=title;section.append(legend);
    this.container.append(section);
    return section;
  }
  private field(parent:HTMLElement,id:string,label:string,type:string,value:string) {
    const row=document.createElement('label');row.textContent=label;
    const input=type==='textarea'?document.createElement('textarea'):document.createElement('input');
    if(input instanceof HTMLInputElement){input.type=type;if(type==='number')input.step='any';}
    input.setAttribute('aria-label',label);input.value=value;
    this.fields[id]=input;row.append(input);parent.append(row);
    return input;
  }
  private select(parent:HTMLElement,id:string,label:string,choices:readonly string[],value:string) {
    const row=document.createElement('label');row.textContent=label;
    const select=document.createElement('select');select.setAttribute('aria-label',label);
    for(const choice of choices){const option=document.createElement('option');option.value=choice;option.textContent=choice;select.append(option);}
    select.value=value;this.fields[id]=select;row.append(select);parent.append(row);
  }
  private button(parent:HTMLElement,label:string,handler:()=>void|Promise<void>) {
    const button=document.createElement('button');button.textContent=label;
    button.onclick=()=>void this.run(handler);parent.append(button);this.buttons.push(button);
    return button;
  }
  private async run(handler:()=>void|Promise<void>) {
    if(this.running||!this.callbacks.getState()||this.callbacks.getState()?.busy)return;
    this.callbacks.error('');
    this.running=true;this.refresh();
    try {await handler();}
    catch(error){const message=error instanceof Error?error.message:String(error);this.status.textContent=message;this.callbacks.error(message);}
    finally {this.running=false;this.refresh();}
  }
  private requiredState():State {
    const state=this.callbacks.getState();if(!state)throw new Error('Open a PDF before entering takeoff data.');return state;
  }

  /** Discard only the uncommitted picker draft. Called before a page/document render changes. */
  cancelPicking(message?:string) {
    const wasPicking=!!this.picking;
    this.picking=undefined;
    if(wasPicking&&message)this.status.textContent=message;
    this.paintOverlay();
    this.updatePickingControls();
  }

  private beginPicking(target:PickTarget) {
    const state=this.requiredState(), mounted=this.mounted;
    if(state.busy||!mounted||!mounted.frame.isConnected||mounted.pageIndex!==state.pageIndex)throw new Error('Wait for the current PDF page to finish mounting before picking points.');
    this.picking={target,kind:this.fields.kind.value as MeasurementRecord['kind'],pageIndex:state.pageIndex,takeoff:state.takeoff,points:[]};
    if(target==='calibrationPoints')(this.fields.reviewed as HTMLInputElement).checked=false;
    this.verificationContext=undefined;
    this.status.textContent='Picking points on the PDF. No calibration or measurement has been saved.';
    this.paintOverlay();
    mounted.overlay.focus({preventScroll:true});
  }

  private finishPicking() {
    const pick=this.picking;
    if(!pick)return;
    const minimum=pick.target!=='points'?2:pick.kind==='count'?1:pick.kind==='length'||pick.kind==='polyline'||pick.kind==='radius'||pick.kind==='diameter'?2:3;
    if(pick.points.length<minimum)throw new Error(`Pick at least ${minimum} points before finishing.`);
    const maximum=pick.target!=='points'||pick.kind==='length'||pick.kind==='radius'||pick.kind==='diameter'?2:pick.kind==='angle'||pick.kind==='arc'?3:10000;
    if(pick.points.length>maximum)throw new Error(`This tool requires exactly ${maximum} points.`);
    this.fields[pick.target].value=pick.points.map(point=>point.join(',')).join(';');
    if(pick.target==='calibrationPoints')(this.fields.reviewed as HTMLInputElement).checked=false;
    this.cancelPicking('Picked coordinates are ready for review. Nothing has been saved; use the separate calibration, verification or measurement action.');
    this.refresh();
  }

  private updatePickingControls() {
    const state=this.callbacks.getState(), disabled=!state||state.busy||this.running;
    for(const field of Object.values(this.fields))field.disabled=disabled||!!this.picking;
    for(const button of this.buttons)button.disabled=disabled||!!this.picking;
    this.finishButton.disabled=disabled||!this.picking;
    this.cancelButton.disabled=disabled||!this.picking;
  }

  /** Exact PDF.js page transform; CSS scaling is normalized independently of device pixels. */
  mountPage(frame:HTMLElement,viewport:Viewport,pageIndex:number) {
    this.cancelPicking('Page view changed. Point picking cancelled; existing coordinates are unchanged.');
    this.mounted?.events.abort();this.mounted?.overlay.remove();
    const overlay=document.createElementNS('http://www.w3.org/2000/svg','svg');
    overlay.dataset.testid='measurement-overlay';overlay.setAttribute('aria-label','Measurement drawing overlay');
    overlay.setAttribute('role','img');overlay.setAttribute('viewBox',`0 0 ${viewport.width} ${viewport.height}`);
    overlay.setAttribute('preserveAspectRatio','none');overlay.setAttribute('tabindex','-1');
    Object.assign(overlay.style,{position:'absolute',inset:'0',width:'100%',height:'100%',zIndex:'5',pointerEvents:'none',touchAction:'none'});
    frame.append(overlay);
    const events=new AbortController();
    this.mounted={frame,viewport,pageIndex,overlay,events};
    // Dynamic fill: one click inside a closed region of the rendered page.
    window.addEventListener('pointerdown',event=>{
      if(!this.fillArmed||!frame.contains(event.target as Node)||event.button!==0)return;
      event.preventDefault();event.stopImmediatePropagation();this.fillArmed=false;
      try{
        const canvas=frame.querySelector('canvas');if(!canvas)throw new Error('The page is not rendered yet.');
        const rect=canvas.getBoundingClientRect(),sx=canvas.width/rect.width,sy=canvas.height/rect.height;
        const image=canvas.getContext('2d',{willReadFrequently:true})!.getImageData(0,0,canvas.width,canvas.height);
        const gap=Number(this.fields.fillGap.value)||0;
        const polygon=fillRegion(image.data,canvas.width,canvas.height,[(event.clientX-rect.left)*sx,(event.clientY-rect.top)*sy],{gapPixels:gap});
        const toPdf=([x,y]:[number,number])=>viewport.convertToPdfPoint(x*viewport.width/canvas.width,y*viewport.height/canvas.height) as Point;
        const round=(value:number)=>Math.round(value*1000)/1000;
        this.fields.kind.value='area';
        this.fields.points.value=polygon.map(point=>toPdf(point).map(round).join(',')).join(';');
        this.paintOverlay();
        this.status.textContent=`Filled region traced with ${polygon.length} vertices. Review the outline, then use Add measurement.`;
      }catch(error){this.status.textContent=error instanceof Error?error.message:String(error);}
    },{capture:true,signal:events.signal});
    // Markup tools listen in frame capture. Intercept just our active overlay before that phase.
    window.addEventListener('pointerdown',event=>{
      const pick=this.picking,state=this.callbacks.getState();
      if(!pick||!overlay.contains(event.target as Node)||event.button!==0)return;
      event.preventDefault();event.stopImmediatePropagation();
      if(!state||state.busy||state.pageIndex!==pageIndex||state.takeoff!==pick.takeoff||!frame.isConnected){this.cancelPicking('Page context changed. Point picking cancelled.');return;}
      try{
        const rect=overlay.getBoundingClientRect();
        if(rect.width<=0||rect.height<=0)throw new Error('The PDF page is not visible for point picking.');
        const raw:Point=[(event.clientX-rect.left)*viewport.width/rect.width,(event.clientY-rect.top)*viewport.height/rect.height];
        const toScreen=(value:Point)=>viewport.convertToViewportPoint(value[0],value[1]) as Point;
        const pdfVertices=(this.fields.snap as HTMLInputElement).checked?[...pick.takeoff.records.filter(record=>record.pageIndex===pageIndex).flatMap(record=>record.points),...pick.points]:[];
        const drawing=this.drawing;
        if((this.fields.snapDrawing as HTMLInputElement).checked&&drawing&&drawing.pageIndex===pageIndex&&drawing.frame===frame)pdfVertices.push(...drawing.vertices.points,...drawing.vertices.derived);
        const screenVertices=pdfVertices.map(toScreen),previous=pick.points.at(-1);
        // Screen tolerance scales with zoom; exact stored vertices are reused instead of round-tripping.
        const snap=snapPick(raw,{tolerance:snapTolerancePixels*viewport.width/rect.width,vertices:screenVertices,anchor:previous&&toScreen(previous),orthogonal:event.shiftKey});
        const point=snap.kind==='vertex'?[...pdfVertices[screenVertices.findIndex(vertex=>vertex[0]===snap.point[0]&&vertex[1]===snap.point[1])]]:viewport.convertToPdfPoint(snap.point[0],snap.point[1]);
        const bounds=state.pageBounds,epsilon=1e-7;
        if(point.length!==2||point.some(value=>!Number.isFinite(value))||point[0]<bounds[0]-epsilon||point[0]>bounds[2]+epsilon||point[1]<bounds[1]-epsilon||point[1]>bounds[3]+epsilon)throw new Error('Pick a point inside the current PDF page.');
        if(pick.points.length>=10000)throw new Error('Point picking supports at most 10,000 points per measurement.');
        pick.points.push([Math.max(bounds[0],Math.min(bounds[2],point[0])),Math.max(bounds[1],Math.min(bounds[3],point[1]))]);
        const expected=pick.target!=='points'||pick.kind==='length'||pick.kind==='radius'||pick.kind==='diameter'?2:pick.kind==='angle'||pick.kind==='arc'?3:undefined;
        this.status.textContent=`${pick.points.length} draft point(s) picked${snap.kind==='vertex'?', snapped to an existing point':snap.kind==='orthogonal'?', constrained horizontally or vertically':''}. No measurement has been saved.`;
        this.paintOverlay();
        if(expected&&pick.points.length===expected)this.finishPicking();
      }catch(error){const message=error instanceof Error?error.message:String(error);this.status.textContent=message;this.callbacks.error(message);}
    },{capture:true,signal:events.signal});
    window.addEventListener('keydown',event=>{
      if(!this.picking)return;
      if(event.key==='Escape'){event.preventDefault();this.cancelPicking('Point picking cancelled. Existing coordinates are unchanged.');this.refresh();}
      else if(event.key==='Backspace'&&event.target===overlay){event.preventDefault();this.picking.points.pop();this.paintOverlay();this.status.textContent=`${this.picking.points.length} draft point(s) picked. No measurement has been saved.`;}
    },{capture:true,signal:events.signal});
    this.paintOverlay();this.refresh();
  }

  /** Vector endpoints extracted after render; ignored unless they belong to the mounted frame. */
  setDrawingVertices(frame:HTMLElement,pageIndex:number,vertices:DrawingVertices) {
    if(this.mounted?.frame!==frame||this.mounted.pageIndex!==pageIndex)return;
    this.drawing={pageIndex,frame,vertices};
    this.mounted.overlay.dataset.drawingVertices=String(vertices.points.length+vertices.derived.length);
    if(vertices.truncated)this.status.textContent='Drawing snapping uses only the first 50,000 vector points on this page.';
  }

  private paintOverlay() {
    const mounted=this.mounted;if(!mounted)return;
    const {overlay,viewport,pageIndex}=mounted,state=this.callbacks.getState();
    overlay.replaceChildren();overlay.dataset.picking=String(!!this.picking);
    overlay.style.pointerEvents=this.picking?'auto':'none';overlay.style.cursor=this.picking?'crosshair':'default';
    overlay.setAttribute('tabindex',this.picking?'0':'-1');
    const draw=(points:Point[],kind:MeasurementRecord['kind'],label:string,color:string)=>{
      if(!points.length)return;
      const converted=points.map(point=>viewport.convertToViewportPoint(point[0],point[1]));
      const group=document.createElementNS('http://www.w3.org/2000/svg','g');
      const title=document.createElementNS('http://www.w3.org/2000/svg','title');title.textContent=label;group.append(title);
      if(kind!=='count'&&converted.length>1){
        const path=document.createElementNS('http://www.w3.org/2000/svg','polyline');
        const closed=['area','perimeter','volume','space'].includes(kind)&&converted.length>2;
        path.setAttribute('points',[...converted,...(closed?[converted[0]]:[])].map(point=>point.join(',')).join(' '));
        path.setAttribute('fill',closed?'#168aad22':'none');path.setAttribute('stroke',color);path.setAttribute('stroke-width','2');path.setAttribute('vector-effect','non-scaling-stroke');group.append(path);
      }
      for(const point of converted){const circle=document.createElementNS('http://www.w3.org/2000/svg','circle');circle.setAttribute('cx',String(point[0]));circle.setAttribute('cy',String(point[1]));circle.setAttribute('r','3');circle.setAttribute('fill',color);group.append(circle);}
      overlay.append(group);
    };
    if(state?.pageIndex===pageIndex)for(const record of state.takeoff.records.filter(record=>record.pageIndex===pageIndex)){draw(record.points,record.kind,`${record.label} (${record.kind})`,'#006b8f');for(const hole of record.cutouts??[])draw(hole,'perimeter',`${record.label} cutout (deducted)`,'#b45309');}
    if(this.picking)draw(this.picking.points,this.picking.target==='points'?this.picking.kind:'length','Uncommitted picked points','#c2410c');
  }
  private number(id:string) {const value=this.fields[id].value.trim();if(!value||!Number.isFinite(Number(value)))throw new Error('Enter a finite known distance or depth.');return Number(value);}
  private points(id:string,bounds:Rect):Point[] {return this.parsePoints(this.fields[id].value,bounds);}
  private parsePoints(text:string,bounds:Rect):Point[] {
    const value=text.trim();
    if(!value)throw new Error('Enter at least one coordinate pair.');
    const points:Point[]=value.split(/[;\n]+/).map(pair=>{
      const coordinates=pair.trim().split(',');
      if(coordinates.length!==2||coordinates.some(value=>!value.trim()||!Number.isFinite(Number(value))))throw new Error('Coordinates must use x,y pairs separated by semicolons or new lines.');
      const point:Point=[Number(coordinates[0]),Number(coordinates[1])];
      if(point[0]<bounds[0]||point[0]>bounds[2]||point[1]<bounds[1]||point[1]>bounds[3])throw new Error('Measurement coordinates must be inside the current PDF page bounds.');
      return point;
    });
    return points;
  }
  private clearImpact() {
    this.impactFingerprint=undefined;
    if(this.fields.approveImpact)(this.fields.approveImpact as HTMLInputElement).checked=false;
    this.impactPanel?.replaceChildren();
  }
  private calibrationCandidate() {
    const state=this.requiredState();
    if(!(this.fields.reviewed as HTMLInputElement).checked)throw new Error('Review the known calibration reference and units, then check Review calibration reference.');
    const points=this.points('calibrationPoints',state.pageBounds);
    if(points.length!==2)throw new Error('Calibration requires exactly two reference points.');
    let viewport:Rect|undefined;
    if((this.fields.useViewport as HTMLInputElement).checked){
      const corners=this.points('viewport',state.pageBounds);
      if(corners.length!==2)throw new Error('Viewport bounds require exactly two corner points.');
      viewport=[corners[0][0],corners[0][1],corners[1][0],corners[1][1]];
    }
    const old=state.takeoff.scales.find(scale=>scale.pageIndex===state.pageIndex&&JSON.stringify(scale.viewport)===JSON.stringify(viewport));
    const scale=calibrateScale({id:old?.id??this.draftScaleId,pageIndex:state.pageIndex,viewport,points:[points[0],points[1]],distance:this.number('distance'),unit:this.fields.calibrationUnit.value as LinearUnit});
    const pageCount=Math.max(state.pageIndex+1,...state.takeoff.records.map(record=>record.pageIndex+1),...state.takeoff.scales.map(item=>item.pageIndex+1));
    const review=reviewCalibrationChange(state.takeoff,[...state.takeoff.scales.filter(item=>item.id!==scale.id),scale],pageCount);
    return {...review,fingerprint:JSON.stringify([state.pageIndex,state.takeoff,review.candidate])};
  }
  private reviewImpact() {
    const review=this.calibrationCandidate();
    this.clearImpact();
    this.impactFingerprint=review.fingerprint;
    const summary=document.createElement('p');
    summary.textContent=`${review.impacts.length} existing measurement(s) affected. Review each value and its calibration evidence before approving.`;
    this.impactPanel.append(summary);
    for(const impact of review.impacts) {
      const row=document.createElement('p');
      row.textContent=`${impact.label}: ${impact.before.value} ${impact.before.unit} → ${impact.after.value} ${impact.after.unit}. Scale evidence will change.`;
      this.impactPanel.append(row);
      const evidence=document.createElement('pre');
      evidence.textContent=JSON.stringify({before:impact.beforeEvidence,after:impact.afterEvidence},null,2);
      this.impactPanel.append(evidence);
    }
    this.status.textContent='Calibration impact preview only. No calibration or quantity changes have been saved.';
  }
  private async saveCalibration() {
    const review=this.calibrationCandidate();
    if(review.impacts.length && (this.impactFingerprint!==review.fingerprint || !(this.fields.approveImpact as HTMLInputElement).checked))
      throw new Error('Review calibration impact and approve the exact quantity changes before saving.');
    await this.callbacks.commit(review.candidate);
    this.clearImpact();this.draftScaleId=crypto.randomUUID();
    (this.fields.reviewed as HTMLInputElement).checked=false;
    this.verificationContext=undefined;
    this.status.textContent='Calibration saved from the reviewed reference. Quantities use the current scales; verify another known distance.';
  }
  private verify() {
    const state=this.requiredState();const points=this.points('verificationPoints',state.pageBounds);
    if(points.length!==2)throw new Error('Verification requires exactly two reference points.');
    const scale=resolveScale(state.takeoff.scales,state.pageIndex,points);
    const result=verifyCalibration(scale,{points:[points[0],points[1]],distance:this.number('verificationDistance'),unit:this.fields.verificationUnit.value as LinearUnit,tolerance:.001});
    this.verificationContext=JSON.stringify([state.pageIndex,state.takeoff.scales]);
    this.verificationTakeoff=state.takeoff;
    this.status.textContent=`Page ${state.pageIndex+1} reference verification ${result.passed?'passed':'failed'}: measured ${result.measured.toFixed(6)}, expected ${result.expected.toFixed(6)} ${this.fields.verificationUnit.value}; relative error ${(result.relativeError*100).toFixed(4)}%. Tolerance 0.1%. This checks only the supplied reference.`;
  }
  private async addMeasurement() {
    const state=this.requiredState();const kind=this.fields.kind.value as MeasurementRecord['kind'];
    const record:MeasurementRecord={id:crypto.randomUUID(),label:this.fields.label.value.trim()||kind,pageIndex:state.pageIndex,kind,points:this.points('points',state.pageBounds),unit:this.fields.unit.value as LinearUnit};
    if(kind==='volume')record.depth={value:this.number('depth'),unit:this.fields.depthUnit.value as LinearUnit};
    const cutouts=this.fields.cutouts.value.trim();
    if(cutouts){if(kind!=='area'&&kind!=='volume'&&kind!=='space')throw new Error('Cutouts apply only to area and volume measurements.');record.cutouts=cutouts.split('|').map(hole=>this.parsePoints(hole,state.pageBounds));}
    const quantity=this.formula();if(quantity)record.quantity=quantity;
    const result=measure({...record,scales:state.takeoff.scales});derivedQuantity(record,result.value);
    await this.callbacks.commit({scales:state.takeoff.scales,records:[...state.takeoff.records,record]});
    this.verificationContext=undefined;
    this.status.textContent=`Measurement added: ${result.value.toFixed(6)} ${result.unit}. Review calibration and geometry before using this quantity.`;
  }

  refresh() {
    const state=this.callbacks.getState();const disabled=!state||state.busy||this.running;
    if(this.picking&&(!state||state.busy||state.pageIndex!==this.picking.pageIndex||state.takeoff!==this.picking.takeoff))this.cancelPicking('Page context changed. Point picking cancelled; existing coordinates are unchanged.');
    this.updatePickingControls();this.paintOverlay();
    this.scales.replaceChildren();this.list.replaceChildren();
    if(!state){this.verificationContext=undefined;this.status.textContent='Open a PDF to calibrate and measure.';return;}
    if(this.status.textContent==='Open a PDF to calibrate and measure.')this.status.textContent='Ready. Calibrate this page from a known distance before measuring length, area or volume.';
    if(state.pageIndex!==this.reviewedPage||state.takeoff!==this.reviewedTakeoff){this.clearImpact();(this.fields.reviewed as HTMLInputElement).checked=false;this.reviewedPage=state.pageIndex;this.reviewedTakeoff=state.takeoff;}
    if(this.verificationContext&&(this.verificationTakeoff!==state.takeoff||this.verificationContext!==JSON.stringify([state.pageIndex,state.takeoff.scales]))){this.verificationContext=undefined;this.status.textContent='Page or calibration changed. Verify a known reference again before using quantities.';}
    const bounds=document.createElement('p');bounds.textContent=`Page ${state.pageIndex+1} bounds: ${state.pageBounds.join(', ')} in original PDF coordinates.`;this.scales.append(bounds);
    const scales=state.takeoff.scales.filter(scale=>scale.pageIndex===state.pageIndex);
    if(!scales.length){const empty=document.createElement('p');empty.textContent='No reviewed scale for this page. Length, area and volume require calibration.';this.scales.append(empty);}
    for(const scale of scales){const item=document.createElement('p');item.textContent=`${scale.viewport?'Viewport '+scale.viewport.join(', '):'Page scale'}: ${scale.metersPerPdfUnit.toPrecision(8)} m per PDF coordinate unit. Reference: ${scale.reference.distance} ${scale.reference.unit}.`;this.scales.append(item);}
    const records=state.takeoff.records.filter(record=>record.pageIndex===state.pageIndex);
    const summary=document.createElement('p');summary.textContent=`${records.length} measurement(s) on this page.`;this.list.append(summary);
    for(const record of records){
      const row=document.createElement('div');const text=document.createElement('p');
      try{const result=measure({...record,scales:state.takeoff.scales});const derived=derivedQuantity(record,result.value);text.textContent=`${record.label} · ${record.kind}: ${result.value.toFixed(6)} ${result.unit}${derived===undefined?'':` → ${derived.toFixed(6)} ${record.quantity!.unitLabel}`.trimEnd()}`;}
      catch(error){text.textContent=`${record.label}: cannot calculate — ${error instanceof Error?error.message:String(error)}`;}
      const remove=document.createElement('button');remove.textContent='Delete measurement';remove.setAttribute('aria-label',`Delete measurement ${record.label}`);remove.disabled=disabled||!!this.picking;
      remove.onclick=()=>void this.run(async()=>{const current=this.requiredState();await this.callbacks.commit({scales:current.takeoff.scales,records:current.takeoff.records.filter(item=>item.id!==record.id)});this.verificationContext=undefined;this.status.textContent='Measurement deleted.';});
      row.append(text,remove);this.list.append(row);
    }
  }
}
