/**
 * EDA Complete Dashboard — reproduce ALL charts from EDA.ipynb
 * 1. Statistics table  2. Channel heatmaps (4×2)  3. Sample line charts
 * 4. Seasonality (Rain + Tide overlay)  5. Correlation heatmap
 */
(function () {
    'use strict';

    const API_BASE = '';
    const REGION = new URLSearchParams(location.search).get('region') || 'DaNang';
    const REP_LAT = 16.0, REP_LNG = 108.1;

    const LAYERS = [
        { key: 'rain',         label: 'Rain (T)',      color: [[0,'#f0f9ff'],[0.25,'#87ceeb'],[0.5,'#5bacd8'],[0.75,'#3182bd'],[1,'#08519c']],  histKey: 'rainfall' },
        { key: 'soilMoisture', label: 'Soil Moisture', color: [[0,'#f0f9ff'],[0.25,'#bae6fd'],[0.5,'#38bdf8'],[0.75,'#0284c7'],[1,'#0c4a6e']],  histKey: 'soilMoisture' },
        { key: 'dem',          label: 'DEM (Elevation)', color: 'Viridis',  histKey: 'dem' },
        { key: 'slope',        label: 'Slope',         color: 'Viridis',  histKey: 'slope' },
        { key: 'flow',         label: 'Flow Acc',      color: 'Viridis',  histKey: 'flow' },
    ];
    const LC = ['#3b82f6','#0ea5e9','#22c55e','#f59e0b','#ef4444'];
    const YC = ['#3b82f6','#f59e0b','#22c55e','#ef4444','#8b5cf6','#a16207'];

    const PL = {
        paper_bgcolor:'rgba(255,255,255,0)', plot_bgcolor:'rgba(255,255,255,0)',
        font:{family:'Inter,sans-serif',size:11,color:'#475569'},
        margin:{t:36,r:10,b:30,l:40},
        xaxis:{gridcolor:'rgba(203,213,225,.4)',zerolinecolor:'rgba(203,213,225,.6)'},
        yaxis:{gridcolor:'rgba(203,213,225,.4)',zerolinecolor:'rgba(203,213,225,.6)'},
    };
    const PC = {displayModeBar:true,modeBarButtonsToRemove:['lasso2d','select2d','autoScale2d'],displaylogo:false,responsive:true};

    const $ = id => document.getElementById(id);
    const $dateInput=$('date-input'), $btnLoad=$('btn-load');
    const $statusBadge=$('status-badge'), $statusText=$('status-text');
    const $loading=$('loading-state');
    const $heatmapsGrid=$('heatmaps-grid'), $samplesGrid=$('samples-grid');
    const $seasonGrid=$('seasonality-grid');
    const $dataInfo=$('data-info');

    let ALL_DATES = []; // stored flat dates list

    function setStatus(t,s){
        $statusBadge.className='status-badge '+t;$statusText.textContent=s;
        $statusBadge.querySelector('.material-icons').textContent=t==='loading'?'autorenew':t==='done'?'check_circle':'error';
    }
    function fmt(v,d=4){return(v==null||isNaN(v))?'N/A':Number(v).toFixed(d);}

    function calcStats(data){
        let min=Infinity,max=-Infinity,sum=0,nan=0,cnt=0;const us=new Set();
        for(let i=0;i<data.length;i++){const v=data[i];if(isNaN(v)||v<-9998){nan++;continue;}if(v<min)min=v;if(v>max)max=v;sum+=v;cnt++;if(us.size<20)us.add(v.toFixed(4));}
        const mean=cnt?sum/cnt:0;let vr=0;for(let i=0;i<data.length;i++){const v=data[i];if(!isNaN(v)&&v>-9998)vr+=(v-mean)**2;}
        return{min:cnt?min:NaN,max:cnt?max:NaN,mean,std:cnt>1?Math.sqrt(vr/(cnt-1)):0,nanCount:nan,uniqueSample:Array.from(us).slice(0,5).join(', ')+(us.size>=5?'...':'')};
    }
    function calcFloodRatio(d){let v=0,f=0;for(let i=0;i<d.length;i++){const x=d[i];if(!isNaN(x)&&x>-9998){v++;if(x>0)f++;}}return v?f/v:0;}
    function to2D(data,r,c){const res=[];for(let i=0;i<r;i++){const row=[];for(let j=0;j<c;j++){const v=data[i*c+j];row.push(isNaN(v)||v<-9998?null:v);}res.push(row);}return res;}

    // ── API ────────────────────────────────────────────────────────────
    async function fetchDates(){
        const res=await fetch(`${API_BASE}/api/dates/${REGION}`);if(!res.ok)throw Error('Dates API');
        const j=await res.json();if(!j?.success)throw Error('No dates');
        const nd=j.data.availableDates,all=[];
        for(const y of Object.keys(nd))for(const m of Object.keys(nd[y]))for(const d of nd[y][m])
            all.push(`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
        all.sort();return all;
    }

    async function fetchGrid(region,date,layerKey){
        const res=await fetch(`${API_BASE}/api/grid/${region}/${date}/${layerKey}?format=bin`);
        if(!res.ok)throw Error(`${layerKey}:${res.status}`);
        const buf=await res.arrayBuffer(),view=new DataView(buf);
        const ml=view.getUint32(0,true),mb=new Uint8Array(buf,4,ml),meta=JSON.parse(new TextDecoder().decode(mb));
        const off=4+ml,len=buf.byteLength-off,ab=new ArrayBuffer(len);
        new Uint8Array(ab).set(new Uint8Array(buf,off,len));
        return{meta,data:new Float32Array(ab)};
    }

    async function fetchPixelHistory(region,lat,lng,start,end){
        const url=`${API_BASE}/api/pixel/history?lat=${lat}&lng=${lng}&region=${region}&startDate=${start}&endDate=${end}`;
        const res=await fetch(url);if(!res.ok)throw Error('History');
        const j=await res.json();return j?.success?j.data:j?.data||[];
    }

    // ── Render functions ───────────────────────────────────────────────
    function renderStats(allData){
        let shape='';
        LAYERS.forEach((l,i)=>{const d=allData[l.key];if(!d)return;
            const{meta,data}=d,r=meta.size.r,c=meta.size.c;
            if(!shape)shape=`(${r}, ${c})`;
        });
        $dataInfo.innerHTML=`<div class="info-chip"><span class="label">Region:</span><span class="value">${REGION}</span></div>
            <div class="info-chip"><span class="label">Channels:</span><span class="value">${Object.keys(allData).length}</span></div>
            <div class="info-chip"><span class="label">Grid:</span><span class="value">${shape}</span></div>`;
        $dataInfo.style.display='flex';
    }

    function renderHeatmaps(allData){
        $heatmapsGrid.innerHTML='';
        LAYERS.forEach(l=>{const d=allData[l.key];if(!d)return;
            const{meta,data}=d,r=meta.size.r,c=meta.size.c;
            const bounds={n:meta.bounds.n??meta.bounds.north,s:meta.bounds.s??meta.bounds.south,
                          e:meta.bounds.e??meta.bounds.east,w:meta.bounds.w??meta.bounds.west};
            const cell=document.createElement('div');cell.className='plot-cell';
            const p=document.createElement('div');p.className='plot-area';p.id='hm-'+l.key;cell.appendChild(p);$heatmapsGrid.appendChild(cell);
            const mx=350;let dr=r,dc=c,dd=data;
            if(r>mx||c>mx){const f=Math.max(Math.ceil(r/mx),Math.ceil(c/mx));dr=Math.ceil(r/f);dc=Math.ceil(c/f);dd=new Float32Array(dr*dc);
                for(let i=0;i<dr;i++)for(let j=0;j<dc;j++)dd[i*dc+j]=data[Math.min(i*f,r-1)*c+Math.min(j*f,c-1)];}
            // Compute lat/lng arrays for axes
            const lngs=[],lats=[];
            for(let j=0;j<dc;j++) lngs.push(+(bounds.w+(bounds.e-bounds.w)*j/dc).toFixed(4));
            for(let i=0;i<dr;i++) lats.push(+(bounds.n-(bounds.n-bounds.s)*i/dr).toFixed(4));
            Plotly.newPlot(p,[{z:to2D(dd,dr,dc),x:lngs,y:lats,type:'heatmap',colorscale:l.color,colorbar:{thickness:10,len:.9,tickfont:{size:9,color:'#475569'},outlinewidth:0},zsmooth:'fast',
                hovertemplate:'Lng:%{x}°<br>Lat:%{y}°<br>Val:%{z:.4f}<extra></extra>'}],
                {...PL,title:{text:l.label,font:{size:12,color:'#1e293b'},x:.5},margin:{t:32,r:45,b:40,l:55},
                    xaxis:{title:{text:'Longitude (°E)',font:{size:10}},tickfont:{size:8}},
                    yaxis:{title:{text:'Latitude (°N)',font:{size:10}},tickfont:{size:8},autorange:'reversed'}},PC);
        });
        $('sec-heatmaps').style.display='';
    }

    const UNITS = {rain:'mm', soilMoisture:'m³/m³', dem:'meters', slope:'degrees', flow:'accumulation', label:'0/1'};

    function renderSampleCharts(allData){
        $samplesGrid.innerHTML='';
        LAYERS.forEach((l,idx)=>{
            const d=allData[l.key];if(!d)return;
            const{meta,data}=d,r=meta.size.r,c=meta.size.c;
            const midRow=Math.floor(r/2),step=Math.max(1,Math.floor(c/450));
            const xs=[],ys=[];
            for(let j=0;j<c;j+=step){const v=data[midRow*c+j];if(!isNaN(v)&&v>-9998){xs.push(xs.length);ys.push(v);}}
            const cell=document.createElement('div');cell.className='plot-cell';
            const p=document.createElement('div');p.className='plot-area';p.id='samp-'+l.key;cell.appendChild(p);$samplesGrid.appendChild(cell);
            const unit = UNITS[l.key] || '';
            Plotly.newPlot(p,[{x:xs,y:ys,type:'scatter',mode:'lines',line:{color:LC[idx],width:1.2},
                hovertemplate:`Col:%{x}<br>${l.label}:%{y:.4f} ${unit}<extra></extra>`}],
                {...PL,title:{text:`${l.label} — Cross-section (Row ${midRow})`,font:{size:12,color:'#1e293b'},x:.5},
                    xaxis:{...PL.xaxis,title:{text:'Pixel Column Index',font:{size:10}}},
                    yaxis:{...PL.yaxis,title:{text:`${l.label} (${unit})`,font:{size:10}}}},PC);
        });
        $('sec-samples').style.display='';
    }

    function renderCorrelation(allData){
        $corrPlot.innerHTML='';
        const feats=LAYERS.filter(l=>l.key!=='label');const names=feats.map(l=>l.label);const N=feats.length;
        const first=feats.find(l=>allData[l.key]);if(!first)return;
        const sz=allData[first.key].data.length,step=Math.max(1,Math.floor(sz/2000));
        const samples=feats.map(l=>{const d=allData[l.key]?.data;if(!d)return null;
            const vals=[];for(let i=0;i<sz;i+=step){const v=d[i];vals.push(!isNaN(v)&&v>-9998?v:null);}return vals;});
        function pearson(a,b){let sx=0,sy=0,sx2=0,sy2=0,sxy=0,n=0;
            for(let i=0;i<a.length;i++){if(a[i]==null||b[i]==null)continue;const x=a[i],y=b[i];sx+=x;sy+=y;sx2+=x*x;sy2+=y*y;sxy+=x*y;n++;}
            if(n<2)return NaN;const dn=Math.sqrt((n*sx2-sx*sx)*(n*sy2-sy*sy));return dn===0?NaN:(n*sxy-sx*sy)/dn;}
        const corr=[];for(let i=0;i<N;i++){const row=[];for(let j=0;j<N;j++){
            if(!samples[i]||!samples[j])row.push(NaN);else{const r=pearson(samples[i],samples[j]);row.push(isNaN(r)?NaN:parseFloat(r.toFixed(2)));}}corr.push(row);}
        const annots=[];for(let i=0;i<N;i++)for(let j=0;j<N;j++){const v=corr[i][j];annots.push({x:j,y:i,text:isNaN(v)?'N/A':v.toFixed(2),font:{size:11,color:!isNaN(v)&&v>0.5?'#1e293b':'#e2e8f0'},showarrow:false});}
        const p=document.createElement('div');p.style.height='500px';$corrPlot.appendChild(p);
        Plotly.newPlot(p,[{z:corr,x:names,y:names,type:'heatmap',colorscale:'Reds',zmin:0,zmax:1,
            colorbar:{thickness:12,tickfont:{size:10,color:'#94a3b8'},outlinewidth:0},
            hovertemplate:'%{y} vs %{x}: %{z:.2f}<extra></extra>'}],
            {...PL,title:{text:'Correlation Heatmap (Event-based)',font:{size:14,color:'#e2e8f0'},x:.5},
                margin:{t:40,r:60,b:80,l:100},annotations:annots,
                xaxis:{tickfont:{size:10,color:'#94a3b8'},tickangle:-30},
                yaxis:{tickfont:{size:10,color:'#94a3b8'},autorange:'reversed'}},PC);
        $('sec-correlation').style.display='';
    }

    async function renderSeasonality(latestDate){
        try{
            setStatus('loading','Đang tải lịch sử pixel (seasonality)...');
            const history=await fetchPixelHistory(REGION,REP_LAT,REP_LNG,'2020-01-01',latestDate);
            if(!history?.length){console.warn('No pixel history');return;}
            const byYear={};
            history.forEach(d=>{const y=d.date.slice(0,4),doy=Math.floor((new Date(d.date)-new Date(d.date.slice(0,4)+'-01-01'))/(86400000))+1;
                if(!byYear[y])byYear[y]=[];byYear[y].push({doy,...d});});
            const years=Object.keys(byYear).sort();
            // Rain
            const rCell=document.createElement('div');rCell.className='plot-cell';
            const rP=document.createElement('div');rP.className='plot-area-lg';rP.id='season-rain';rCell.appendChild(rP);$seasonGrid.appendChild(rCell);
            Plotly.newPlot(rP,years.map((y,i)=>({x:byYear[y].map(d=>d.doy),y:byYear[y].map(d=>d.rainfall??0),
                type:'scatter',mode:'lines',name:y,line:{color:YC[i%YC.length],width:1.5}})),
                {...PL,title:{text:'Rain Seasonality (Overlay by Year)',font:{size:13,color:'#1e293b'},x:.5},
                    margin:{t:40,r:10,b:40,l:50},legend:{font:{size:10,color:'#475569'},bgcolor:'rgba(0,0,0,0)'},
                    xaxis:{...PL.xaxis,title:{text:'Day of Year',font:{size:10}}},yaxis:{...PL.yaxis,title:{text:'Rain',font:{size:10}}}},PC);
            $('sec-seasonality').style.display='';
        }catch(e){console.warn('Seasonality failed:',e);}
    }

    // ── Main flow ──────────────────────────────────────────────────────
    async function loadDashboard(date){
        try{
            setStatus('loading',`Đang tải ${LAYERS.length} layers [${date}]...`);
            // Clear previous
            $seasonGrid.innerHTML='';
            $('sec-heatmaps').style.display='none';
            $('sec-samples').style.display='none';$('sec-seasonality').style.display='none';
            $loading.style.display='flex';

            const results=await Promise.all(LAYERS.map(l=>fetchGrid(REGION,date,l.key).then(r=>({key:l.key,...r})).catch(e=>{console.warn(l.key,e.message);return{key:l.key,meta:null,data:null};})));
            const allData={};let cnt=0;
            results.forEach(r=>{if(r.data){allData[r.key]={meta:r.meta,data:r.data};cnt++;}});
            if(!cnt)throw Error('Không có dữ liệu nào tải được');
            $loading.style.display='none';

            setStatus('loading','Thống kê...');renderStats(allData);
            setStatus('loading','Heatmaps...');renderHeatmaps(allData);
            setStatus('loading','Sample charts...');renderSampleCharts(allData);
            // Seasonality (async, may take long)
            renderSeasonality(date).then(()=>{
                setStatus('done',`${cnt}/${LAYERS.length} layers · ${date}`);
            }).catch(()=>{
                setStatus('done',`${cnt}/${LAYERS.length} layers · ${date}`);
            });
            setStatus('done',`${cnt}/${LAYERS.length} layers · ${date}`);
        }catch(e){
            console.error('EDA Error:',e);setStatus('error',e.message);
            $loading.innerHTML=`<span class="material-icons" style="animation:none;color:var(--danger)">error</span>${e.message}`;
        }
    }

    function pickRainiestDate(dates){
        // Ưu tiên tháng 9-10/2024 (mùa mưa Đà Nẵng, confirmed có data mưa)
        const best2024 = dates.filter(d => d.startsWith('2024-09') || d.startsWith('2024-10'));
        if (best2024.length) return best2024[Math.floor(best2024.length/2)];
        // Fallback: tháng 9-11 bất kỳ năm
        const rainAny = dates.filter(d => /-(?:09|10|11)-/.test(d));
        if (rainAny.length) return rainAny[Math.floor(rainAny.length/2)];
        return dates[dates.length-1];
    }

    async function init(){
        try{
            setStatus('loading','Đang tải danh sách ngày...');
            ALL_DATES = await fetchDates();
            const urlDate = new URLSearchParams(location.search).get('date');
            const bestDate = urlDate || pickRainiestDate(ALL_DATES);
            $dateInput.value = bestDate;
            $dateInput.min = ALL_DATES[0];
            $dateInput.max = ALL_DATES[ALL_DATES.length-1];
            await loadDashboard(bestDate);
        }catch(e){
            console.error(e);setStatus('error',e.message);
            $loading.innerHTML=`<span class="material-icons" style="animation:none;color:var(--danger)">error</span>${e.message}`;
        }
    }

    // Date picker change
    $btnLoad.addEventListener('click',()=>{
        const d=$dateInput.value;if(d)loadDashboard(d);
    });
    $dateInput.addEventListener('keydown',e=>{if(e.key==='Enter'){const d=$dateInput.value;if(d)loadDashboard(d);}});

    init();
})();
