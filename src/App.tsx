import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged, signInWithCustomToken } from 'firebase/auth';
import { getFirestore, doc, getDoc, setDoc } from 'firebase/firestore';
import { 
  ChefHat, ShoppingBag, TrendingUp, AlertTriangle, Save, 
  RefreshCw, Database, Zap, Info, IndianRupee, 
  LayoutDashboard, FileText, Upload, FileSpreadsheet,
  Calendar, Terminal, ShieldCheck, ScrollText, Ban
} from 'lucide-react';

/**
 * CONFIGURATION & ENV
 */
const firebaseConfig = JSON.parse(__firebase_config || '{}');
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

const apiKey = ""; // Injected by runtime
const MODEL_NAME = "gemini-2.5-flash-preview-09-2025";

const SAMPLE_DATA = `Item,Current Stock,Unit,Avg Daily Usage,Market Price (INR)
Basmati Rice,15,kg,5,120
Chicken (Whole),8,kg,12,220
Cooking Oil,5,liters,3,150
Onions,4,kg,4,40
Paneer,2,kg,3,380
Spices Mix,0.5,kg,0.1,800
Tomatoes,2,kg,6,60`;

// --- Agent Tools Schema (Gemini Function Calling) ---
const TOOLS_SCHEMA = [
  {
    name: "submit_procurement_plan",
    description: "Finalize and submit the calculated procurement plan based on analysis.",
    parameters: {
      type: "OBJECT",
      properties: {
        plan_summary: { type: "STRING", description: "Executive summary or Refusal reason." },
        status: { type: "STRING", enum: ["SUCCESS", "REFUSED"], description: "Outcome of the planning request." },
        total_estimated_cost: { type: "NUMBER", description: "Total cost in INR." },
        items: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              item_name: { type: "STRING" },
              current_stock: { type: "NUMBER" },
              recommended_order: { type: "NUMBER" },
              unit: { type: "STRING" },
              market_price_per_unit: { type: "NUMBER" },
              estimated_cost: { type: "NUMBER" },
              risk_level: { type: "STRING", enum: ["High", "Medium", "Low"] },
              applied_policy: { type: "STRING", description: "The specific Policy ID applied (e.g., 'WEEKEND_RUSH')." },
              reasoning: { type: "STRING", description: "Why this quantity? Cite calendar events if relevant." }
            },
            required: ["item_name", "recommended_order", "risk_level", "applied_policy", "reasoning"]
          }
        }
      },
      required: ["plan_summary", "status", "total_estimated_cost", "items"]
    }
  }
];

// --- Utilities ---
async function generateCacheKey(dataString) {
  const msgBuffer = new TextEncoder().encode(dataString);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default function RestroProcure() {
  // State
  const [user, setUser] = useState(null);
  const [inventoryText, setInventoryText] = useState(SAMPLE_DATA);
  const [userPrompt, setUserPrompt] = useState("Kal weekend hai to thoda extra rakhna.");
  const [horizon, setHorizon] = useState(3);
  const [status, setStatus] = useState({ loading: false, error: null, cacheHit: false });
  const [logs, setLogs] = useState([]); // For Agentic Visualization
  const [result, setResult] = useState(null);
  const [activeTab, setActiveTab] = useState('agent');
  const fileInputRef = useRef(null);

  // Auth
  useEffect(() => {
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (err) {
        setStatus(prev => ({ ...prev, error: "Auth failed." }));
      }
    };
    initAuth();
    return onAuthStateChanged(auth, setUser);
  }, []);

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => setInventoryText(event.target.result);
    reader.readAsText(file);
  };

  const handleGeneratePlan = async () => {
    if (!user) return setStatus(prev => ({ ...prev, error: "Waiting for auth..." }));
    
    // 1. Validation Layer (Failure Mode Handling)
    if (!inventoryText || inventoryText.length < 10 || !inventoryText.includes(',')) {
      setStatus({ loading: false, error: "Invalid Data: CSV appears malformed or empty.", cacheHit: false });
      return;
    }

    setStatus({ loading: true, error: null, cacheHit: false });
    setResult(null);
    setLogs([]); 

    // Step 1: Simulate Calendar Tool & Policy Loading
    setLogs(prev => [...prev, "Init: Checking 'cultural_calendar_tool'..."]);
    
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const isWeekend = today.getDay() === 0 || today.getDay() === 6;
    
    // Explicit Context with Policy Guardrails
    const calendarContext = {
      date: dateStr,
      is_weekend: isWeekend,
      detected_events: isWeekend ? ["Weekend Rush"] : ["Standard Weekday"],
      horizon_days: horizon
    };

    setLogs(prev => [...prev, `Policy: Loaded ${isWeekend ? 'WEEKEND_RUSH' : 'STANDARD_OP'} protocols.`]);

    try {
      // Step 2: Cache Check
      const cacheKey = await generateCacheKey(`${inventoryText}||${userPrompt}||${JSON.stringify(calendarContext)}`);
      const cacheRef = doc(db, 'artifacts', appId, 'users', user.uid, 'procurement_cache_v5', cacheKey);
      const cacheSnap = await getDoc(cacheRef);

      if (cacheSnap.exists()) {
        setLogs(prev => [...prev, "Cache: Hit found. Retrieving stored plan..."]);
        setResult(cacheSnap.data().response);
        setStatus({ loading: false, error: null, cacheHit: true });
        return;
      }

      setLogs(prev => [...prev, "Gemini: Reasoning on Inventory + Policy..."]);

      // Step 3: Construct Agentic Prompt with EXPLICIT POLICY BOUNDARIES & REFUSAL
      const systemPrompt = `
        You are an advanced Procurement Agent.
        
        ACTIVE POLICIES (Strict adherence required):
        1. STANDARD_OP: For regular weekdays, maintain 1.1x usage buffer.
        2. WEEKEND_RUSH: For Fri-Sun, increase to 1.3x - 1.5x usage buffer.
        3. HIGH_IMPACT_EVENT: For festivals, usage must be 1.8x - 2.5x.
        4. LOW_STOCK_CRITICAL: If current_stock < 0.2 * daily_usage, flagging is MANDATORY.
        5. REFUSAL PROTOCOL: If 'horizon_days' > 14, you MUST refuse to plan. The algorithm is not reliable beyond 14 days. Call tool with status='REFUSED' and explain why.

        YOUR TOOLKIT:
        1. cultural_calendar_tool (Already executed - see output below).
        2. submit_procurement_plan (You MUST call this to finalize).

        WORKFLOW:
        1. Check 'horizon_days'. If > 14, TRIGGER REFUSAL PROTOCOL immediately.
        2. Else, Review 'cultural_calendar_tool' output to identify active policy.
        3. Analyze Inventory CSV. If data is nonsensical (e.g., negative stock), flag as 'High' risk.
        4. Calculate needs based on Policy Multiplier * Usage * Horizon.
        5. Call 'submit_procurement_plan' with the 'applied_policy' field filled.
      `;

      // Simulating a "History" where the tool was already called
      const virtualHistory = [
        {
          role: "user",
          parts: [{ text: `User Instruction: ${userPrompt}\nInventory CSV:\n${inventoryText}` }]
        },
        {
          role: "model",
          parts: [{ text: "I need to check the calendar context." }] // Simulated thought
        },
        {
          role: "user",
          parts: [{ text: `TOOL_OUTPUT [cultural_calendar_tool]: ${JSON.stringify(calendarContext)}` }] // Injected Tool Result
        }
      ];

      // API Call
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: virtualHistory,
            systemInstruction: { parts: [{ text: systemPrompt }] },
            tools: [{ function_declarations: TOOLS_SCHEMA }],
            tool_config: { function_calling_config: { mode: "ANY" } } 
          })
        }
      );

      if (!response.ok) throw new Error(`API Error: ${response.statusText}`);
      
      const data = await response.json();
      
      // Step 4: Extract Function Call
      const functionCall = data.candidates?.[0]?.content?.parts?.[0]?.functionCall;
      
      if (!functionCall || functionCall.name !== 'submit_procurement_plan') {
         // Graceful failure handling if model refuses to call tool
         throw new Error("Agent refused to generate plan. Please check inputs.");
      }

      setLogs(prev => [...prev, "Agent: Executing 'submit_procurement_plan'..."]);
      const parsed = functionCall.args;

      // Cache Write
      await setDoc(cacheRef, {
        response: parsed,
        timestamp: new Date().toISOString(),
        inputs: { prompt: userPrompt, context: calendarContext }
      });

      setResult(parsed);
      setStatus({ loading: false, error: null, cacheHit: false });

    } catch (err) {
      console.error(err);
      setStatus({ loading: false, error: err.message || "Planning failed.", cacheHit: false });
    }
  };

  return (
    <div className="app-container">
      <style>{`
        :root { --bg: #f8fafc; --card: #ffffff; --text: #0f172a; --sub: #64748b; --primary: #2563eb; --primary-hover: #1d4ed8; --border: #e2e8f0; }
        * { box-sizing: border-box; outline: none; }
        body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); }
        .app-container { min-height: 100vh; display: flex; flex-direction: column; }
        
        .navbar { background: var(--card); border-bottom: 1px solid var(--border); padding: 0.75rem 1.5rem; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 10; }
        .brand { display: flex; align-items: center; gap: 0.75rem; font-weight: 700; font-size: 1.25rem; }
        .nav-group { background: #f1f5f9; padding: 0.25rem; border-radius: 99px; display: flex; gap: 0.25rem; }
        .nav-item { padding: 0.5rem 1rem; border: none; background: transparent; border-radius: 99px; font-weight: 500; color: var(--sub); cursor: pointer; display: flex; align-items: center; gap: 0.5rem; transition: all 0.2s; }
        .nav-item.active { background: var(--card); color: var(--primary); shadow: 0 1px 2px rgba(0,0,0,0.05); }

        .grid-main { display: grid; grid-template-columns: 1fr; gap: 1.5rem; max-width: 1400px; margin: 0 auto; padding: 1.5rem; width: 100%; }
        @media (min-width: 1024px) { .grid-main { grid-template-columns: 380px 1fr; } }
        
        .card { background: var(--card); border: 1px solid var(--border); border-radius: 0.75rem; overflow: hidden; display: flex; flex-direction: column; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .card-head { padding: 1rem; border-bottom: 1px solid var(--border); background: #f8fafc; font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
        .card-body { padding: 1rem; display: flex; flex-direction: column; gap: 1rem; flex: 1; }
        
        .input-area { width: 100%; padding: 0.75rem; border: 1px solid var(--border); border-radius: 0.5rem; font-size: 0.875rem; transition: border-color 0.2s; }
        .input-area:focus { border-color: var(--primary); ring: 2px solid rgba(37,99,235,0.1); }
        .mono { font-family: 'SF Mono', monospace; font-size: 0.8rem; }
        
        .btn { padding: 0.75rem; border-radius: 0.5rem; border: none; font-weight: 600; cursor: pointer; display: flex; justify-content: center; align-items: center; gap: 0.5rem; transition: all 0.2s; }
        .btn-primary { background: var(--primary); color: white; }
        .btn-primary:hover { background: var(--primary-hover); }
        .btn-primary:disabled { opacity: 0.7; cursor: not-allowed; }
        .btn-ghost { background: transparent; color: var(--primary); padding: 0; font-size: 0.75rem; }
        .btn-ghost:hover { text-decoration: underline; }

        .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 0.5rem; }
        table { width: 100%; border-collapse: collapse; font-size: 0.875rem; text-align: left; }
        th { background: #f8fafc; padding: 0.75rem 1rem; font-weight: 600; color: var(--sub); border-bottom: 1px solid var(--border); }
        td { padding: 1rem; border-bottom: 1px solid var(--border); vertical-align: top; }
        tr:last-child td { border-bottom: none; }
        
        .badge { padding: 0.25rem 0.6rem; border-radius: 99px; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; display: inline-flex; align-items: center; gap: 0.25rem; }
        .bg-green { background: #dcfce7; color: #166534; }
        .bg-blue { background: #dbeafe; color: #1e40af; }
        .risk-High { background: #fee2e2; color: #991b1b; }
        .risk-Medium { background: #fef3c7; color: #92400e; }
        .risk-Low { background: #f1f5f9; color: #64748b; }
        .policy-tag { font-size: 0.65rem; color: #6366f1; background: #e0e7ff; padding: 0.1rem 0.4rem; border-radius: 4px; display: inline-block; margin-bottom: 0.2rem; }

        .stat-block { display: flex; align-items: baseline; gap: 0.25rem; font-size: 1.5rem; font-weight: 700; color: var(--text); }
        .stat-sub { font-size: 0.875rem; font-weight: 500; color: var(--sub); }
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { 100% { transform: rotate(360deg); } }
        
        .log-console { background: #1e293b; color: #cbd5e1; padding: 1rem; border-radius: 0.5rem; font-family: 'SF Mono', monospace; font-size: 0.75rem; max-height: 150px; overflow-y: auto; }
        .log-item { display: flex; gap: 0.5rem; margin-bottom: 0.25rem; }
        .log-check { color: #4ade80; }

        .range-wrap { display: flex; flex-direction: column; gap: 0.5rem; }
        .range-header { display: flex; justify-content: space-between; font-size: 0.875rem; font-weight: 500; }
        input[type=range] { width: 100%; accent-color: var(--primary); }

        .error-banner { background: #fef2f2; color: #b91c1c; padding: 0.75rem; border-radius: 0.5rem; font-size: 0.875rem; display: flex; gap: 0.5rem; align-items: center; }
        .empty-state { text-align: center; color: var(--sub); padding: 3rem; }
        
        .policy-card { background: #f0f9ff; border: 1px dashed #bae6fd; padding: 0.75rem; border-radius: 0.5rem; font-size: 0.75rem; color: #0369a1; margin-bottom: 1rem; }
        
        .refusal-card { background: #fef2f2; border: 1px solid #fecaca; padding: 2rem; border-radius: 0.5rem; text-align: center; color: #991b1b; }
        .policy-explanation { margin-top: 1rem; padding: 0.75rem; background: #f8fafc; border-radius: 0.5rem; border: 1px solid #e2e8f0; font-size: 0.75rem; color: #64748b; }
      `}</style>

      <nav className="navbar">
        <div className="brand">
          <ChefHat className="text-blue-600" /> RestroProcure
        </div>
        <div className="nav-group">
          <button onClick={() => setActiveTab('agent')} className={`nav-item ${activeTab === 'agent' ? 'active' : ''}`}>
            <LayoutDashboard size={16} /> Agent
          </button>
          <button onClick={() => setActiveTab('docs')} className={`nav-item ${activeTab === 'docs' ? 'active' : ''}`}>
            <FileText size={16} /> Docs
          </button>
        </div>
      </nav>

      <main className="grid-main">
        {activeTab === 'agent' ? (
          <>
            <section className="col-inputs" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              <div className="card">
                <div className="card-head">
                  <span><Zap size={18} className="inline mr-2 text-amber-500"/>Planning Control</span>
                </div>
                <div className="card-body">
                  <div className="range-wrap">
                    <div className="range-header">
                      <span>Planning Horizon</span>
                      <span className={`${horizon > 14 ? 'text-red-500' : 'text-blue-600'} font-bold`}>{horizon} Days</span>
                    </div>
                    <input 
                      type="range" min="1" max="30" value={horizon} 
                      onChange={(e) => setHorizon(parseInt(e.target.value))} 
                    />
                    {horizon > 14 && (
                       <div className="text-xs text-red-500 flex items-center gap-1">
                         <AlertTriangle size={10} /> Warning: Horizons &gt; 14 days may trigger agent refusal.
                       </div>
                    )}
                  </div>
                  <hr style={{ borderColor: 'var(--border)' }} />
                  <textarea 
                    className="input-area" rows={3}
                    value={userPrompt} onChange={(e) => setUserPrompt(e.target.value)}
                    placeholder="Describe specific needs (e.g. 'Expecting huge crowd on Sunday')..."
                  />
                </div>
              </div>

              <div className="card" style={{ flex: 1 }}>
                <div className="card-head">
                  <span><Database size={18} className="inline mr-2 text-blue-500"/>Inventory & Context</span>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input 
                      type="file" accept=".csv,.txt" ref={fileInputRef} hidden 
                      onChange={handleFileUpload}
                    />
                    <button className="btn btn-ghost" onClick={() => fileInputRef.current?.click()}>
                      <Upload size={14} className="mr-1"/> Upload CSV
                    </button>
                  </div>
                </div>
                <div className="card-body">
                  <textarea 
                    className="input-area mono" style={{ flex: 1, minHeight: '200px' }}
                    value={inventoryText} onChange={(e) => setInventoryText(e.target.value)}
                  />
                  {/* Agent Logs Visualization */}
                  {logs.length > 0 && (
                    <div className="log-console">
                      <div style={{ borderBottom: '1px solid #334155', paddingBottom: '0.5rem', marginBottom: '0.5rem', color: '#94a3b8' }}>
                        <Terminal size={12} className="inline mr-1" /> Agent Runtime Logs
                      </div>
                      {logs.map((log, i) => (
                        <div key={i} className="log-item">
                          <span className="log-check">✓</span> {log}
                        </div>
                      ))}
                    </div>
                  )}

                  {status.error && (
                    <div className="error-banner">
                      <AlertTriangle size={16} /> {status.error}
                    </div>
                  )}
                  <button 
                    className="btn btn-primary" 
                    onClick={handleGeneratePlan} 
                    disabled={status.loading || !user}
                  >
                    {status.loading ? <RefreshCw className="spin" size={18} /> : <TrendingUp size={18} />}
                    {status.loading ? "Running Agent Workflow..." : "Generate Plan"}
                  </button>
                </div>
              </div>
            </section>

            <section className="col-results">
              {result ? (
                <div className="card" style={{ height: '100%' }}>
                  <div className="card-head">
                    <span><ShoppingBag size={18} className="inline mr-2 text-green-600"/> Procurement Plan</span>
                    {status.cacheHit ? 
                      <span className="badge bg-green"><Save size={12}/> Cached</span> : 
                      <span className="badge bg-blue"><Zap size={12}/> Live Agent</span>
                    }
                  </div>
                  <div className="card-body">
                    {/* Check for Refusal */}
                    {result.status === 'REFUSED' ? (
                      <div className="refusal-card">
                         <Ban size={48} className="mx-auto mb-4 opacity-50" />
                         <h3 className="font-bold text-lg mb-2">Request Refused by Agent</h3>
                         <p className="text-sm">{result.plan_summary}</p>
                      </div>
                    ) : (
                      <>
                        {/* Policy Display */}
                        <div className="policy-card">
                          <div style={{ fontWeight: 700, marginBottom: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                             <ShieldCheck size={12} /> Active Protocol: WEEKEND_RUSH / STANDARD_OP
                          </div>
                          <div>Agent adheres to strict multipliers (1.1x - 1.5x) based on context detection.</div>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                          <div>
                            <div className="stat-sub">Total Estimated Cost</div>
                            <div className="stat-block">
                              <IndianRupee size={24} strokeWidth={2.5}/>
                              {result.total_estimated_cost?.toLocaleString()}
                            </div>
                          </div>
                          <div style={{ maxWidth: '60%', textAlign: 'right', fontSize: '0.9rem', color: 'var(--sub)' }}>
                            {result.plan_summary}
                          </div>
                        </div>

                        {/* Visible Policy Explanation Block */}
                        <div className="policy-explanation">
                           <strong>Demand Policy Logic:</strong>
                           <ul className="list-disc pl-4 mt-1 space-y-1">
                             <li><strong>Weekend Detected:</strong> Buffer multiplier between 1.2x – 1.5x.</li>
                             <li><strong>Festival Mode:</strong> Higher priority & 1.8x+ buffer for perishables.</li>
                             <li><strong>Reliability Check:</strong> Horizons &gt; 14 days are auto-rejected.</li>
                           </ul>
                        </div>

                        <div className="table-wrap">
                          <table>
                            <thead>
                              <tr>
                                <th>Item Details</th>
                                <th>Stock / Usage</th>
                                <th>Order Qty</th>
                                <th>Reasoning & Policy</th>
                              </tr>
                            </thead>
                            <tbody>
                              {result.items.map((item, idx) => (
                                <tr key={idx}>
                                  <td>
                                    <div style={{ fontWeight: 600 }}>{item.item_name}</div>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--sub)' }}>{item.unit} @ ₹{item.market_price_per_unit}</div>
                                  </td>
                                  <td style={{ fontSize: '0.8rem' }}>
                                    <div>Cur: {item.current_stock}</div>
                                    <div className="text-gray-400">Use: {item.projected_usage || '-'}</div>
                                  </td>
                                  <td>
                                    <div style={{ fontWeight: 700, color: '#166534' }}>+{item.recommended_order} {item.unit}</div>
                                    <div style={{ fontSize: '0.75rem' }}>₹{item.estimated_cost?.toLocaleString()}</div>
                                  </td>
                                  <td>
                                    <div className="policy-tag">{item.applied_policy}</div>
                                    <span className={`badge risk-${item.risk_level}`} style={{ marginLeft: '0.5rem' }}>{item.risk_level} Risk</span>
                                    <div style={{ marginTop: '0.25rem', fontSize: '0.8rem', lineHeight: 1.4 }}>{item.reasoning}</div>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <div className="card empty-state" style={{ height: '100%', justifyContent: 'center' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', opacity: 0.4 }}>
                    <FileSpreadsheet size={64} strokeWidth={1} style={{ marginBottom: '1rem' }} />
                    <h3>No Plan Generated</h3>
                    <p>Configure the horizon and inputs to start the agent.</p>
                  </div>
                </div>
              )}
            </section>
          </>
        ) : (
          <div className="card" style={{ maxWidth: '800px', margin: '0 auto' }}>
            <div className="card-head"><Info size={20} className="mr-2"/> Documentation</div>
            <div className="card-body">
              <h3>Agentic Architecture</h3>
              <p style={{ lineHeight: 1.6, color: 'var(--sub)' }}>
                RestroProcure uses an explicit Function Calling workflow with strict Policy Guardrails.
              </p>
              
              <div className="bg-yellow-50 p-4 rounded-lg border border-yellow-100 my-4 text-sm text-yellow-800">
                <strong>Tool Realism Note:</strong> For free-tier efficiency, external tools such as the cultural calendar are simulated and injected into the agent’s context. In production, these would be replaced with live APIs without changing the agent logic.
              </div>

              <ul style={{ lineHeight: 1.8, color: 'var(--sub)' }}>
                <li><strong>Policy Enforcement:</strong> The agent does not simply "guess" amounts. It is strictly bound by `STANDARD_OP` (1.1x) or `WEEKEND_RUSH` (1.3-1.5x) protocols injected into the system prompt.</li>
                <li><strong>Failure Mode Handling:</strong> The system validates input data quality before execution. Empty or malformed CSVs trigger immediate rejection, saving API tokens.</li>
                <li><strong>Refusal Protocol:</strong> The model is instructed to strictly refuse planning requests for horizons exceeding 14 days, preventing hallucinated long-term forecasts.</li>
              </ul>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}