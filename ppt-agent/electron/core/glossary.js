'use strict';
// 中英双语领域词表：用于查询的中英互译扩展、跨语言检索特征、自动标签与内容归类。
// 每行格式： 分类|中文同义词,...|English synonyms,...
const RAW = `
航空运营|机航,航空,民航|aviation,airline,airlines,air transport
航空运营|航班过站,过站,过站保障,航班保障,过站时间,地面周转|turnaround,aircraft turnaround,turn around,turnaround time,tat
航空运营|航班,航班号|flight,flights
航空运营|准点率,正点率,放行正常率,航班正常率|on-time performance,otp,punctuality
航空运营|协同决策,机场协同决策|a-cdm,acdm,cdm,collaborative decision making,airport collaborative decision making
航空运营|目标撤轮挡时间|tobt,target off-block time
航空运营|目标启动许可时间|tsat,target start-up approval time
航空运营|实际上轮挡时间,上轮挡|aibt,actual in-block time,in-block
航空运营|实际撤轮挡时间,撤轮挡|aobt,actual off-block time,off-block
航空运营|滑行时间,滑出时间,滑入时间|taxi time,exot,exit,taxiing
航空运营|地面保障设备,特种车辆,地服设备|gse,ground support equipment
航空运营|地面服务,地服,地勤|ground handling,ground service,ground services,ground staff
航空运营|机坪,停机坪,站坪|apron,ramp
航空运营|机位,停机位|stand,gate position,parking stand
航空运营|登机口|gate,boarding gate
航空运营|廊桥,登机桥|boarding bridge,jet bridge,passenger boarding bridge,pbb
航空运营|客梯车|passenger stairs,stair truck
航空运营|牵引车,推出,推飞机|pushback,tug,pushback tug,towing
航空运营|行李,行李装卸,行李分拣|baggage,luggage,baggage handling,bhs,baggage handling system
航空运营|配餐,航食|catering,inflight catering
航空运营|加油,航油,燃油|fueling,refueling,fuel,jet fuel
航空运营|除冰,除防冰|de-icing,deicing,anti-icing
航空运营|清洁,客舱清洁|cleaning,cabin cleaning
航空运营|上客,登机|boarding
航空运营|下客|deplaning,disembarking
航空运营|旅客,乘客|passenger,passengers,pax
航空运营|值机|check-in,checkin
航空运营|安检|security check,security screening
航空运营|货运,航空货运,货邮|cargo,air cargo,freight
航空运营|空管,空中交通管制|atc,air traffic control,air traffic management,atm
航空运营|跑道|runway
航空运营|塔台|tower,control tower
航空运营|航司,航空公司|airline,carrier
航空运营|运行控制,运控|operations control,occ,ops control
航空运营|延误,航班延误|delay,flight delay
航空运营|飞机,航空器|aircraft,airplane,plane
航空运营|窄体机|narrow-body,narrowbody
航空运营|宽体机|wide-body,widebody
航空运营|关键路径|critical path
航空运营|里程碑|milestone,milestones
航空运营|甘特图|gantt,gantt chart
航空运营|机务,维修,航线维修|maintenance,mro,line maintenance
机场设施|机场,空港|airport,airports
机场设施|智慧机场,数字机场|smart airport,digital airport
机场设施|航站楼,候机楼,航站区|terminal,terminal building
机场设施|数字孪生|digital twin
机场设施|物联网|iot,internet of things
机场设施|视频监控,摄像头|cctv,video surveillance,camera,cameras
机场设施|外来物,跑道异物|fod,foreign object debris
机场设施|围界,入侵|perimeter,intrusion
安全培训|安全,安全管理|safety,safety management,sms
安全培训|培训,训练|training
安全培训|应急,应急处置,应急预案|emergency,emergency response,contingency
安全培训|危险区域|danger zone,hazard area
安全培训|消防|fire,firefighting,fire fighting
安全培训|反光背心|reflective vest,hi-vis vest
安全培训|标准作业程序,作业规范|sop,standard operating procedure
安全培训|风险,风险管理|risk,risk management
技术AI|人工智能,智能|ai,artificial intelligence,intelligent
技术AI|机器学习|machine learning,ml
技术AI|深度学习|deep learning
技术AI|计算机视觉,视觉识别,图像识别|computer vision,cv,image recognition,vision
技术AI|大模型,大语言模型|llm,large language model,foundation model,gpt
技术AI|检索增强生成,知识库问答|rag,retrieval augmented generation
技术AI|知识库|knowledge base
技术AI|向量,向量数据库,嵌入|vector,vector database,embedding,embeddings
技术AI|语义搜索,语义检索|semantic search
技术AI|混合检索|hybrid retrieval,hybrid search
技术AI|重排序|rerank,reranking,cross-encoder
技术AI|预测,预测模型|prediction,predictive,forecast,forecasting
技术AI|智能体|agent,ai agent
技术AI|算法|algorithm
技术AI|边缘计算,边缘节点|edge computing,edge,edge node
技术AI|自动化|automation,automatic
技术AI|数字化,数字化转型|digitalization,digital transformation
技术AI|平台|platform
技术AI|架构,系统架构,平台架构|architecture,system architecture
技术AI|路线图,规划|roadmap,plan
云与数据|云,云计算,云端|cloud,cloud computing
云与数据|微服务|microservices,microservice
云与数据|容器|container,containers,kubernetes,k8s,docker
云与数据|多活,双活|active-active,multi-region
云与数据|零信任|zero trust
云与数据|数据平台,数据中台|data platform
云与数据|数据湖,湖仓|data lake,lakehouse
云与数据|元数据|metadata,catalog
云与数据|流处理,实时数据|streaming,stream processing,real-time
云与数据|商业智能,报表|bi,business intelligence,dashboard,dashboards
云与数据|数据共享,信息共享|data sharing,information sharing
云与数据|网络安全,信息安全|cybersecurity,information security
云与数据|弹性伸缩,自动扩缩容|auto scaling,autoscaling
云与数据|成本优化,降本|cost optimization,finops,cost saving
财务经营|收入,营业收入,营收|revenue,income,sales revenue
财务经营|利润,净利润|profit,net profit
财务经营|毛利率|gross margin
财务经营|成本,成本控制|cost,cost control
财务经营|现金流,经营现金流|cash flow,operating cash flow
财务经营|同比|year over year,yoy
财务经营|环比|month over month,mom,quarter over quarter
财务经营|季度,第三季度|quarter,q3,quarterly
财务经营|预算|budget
财务经营|采购,集中采购|procurement,purchasing
财务经营|经营分析|business review,operating analysis
财务经营|投资|investment,capex
管理战略|战略|strategy,strategic
管理战略|组织,组织架构|organization,org chart
管理战略|绩效,考核,关键绩效指标|kpi,performance,key performance indicator
管理战略|项目管理|project management,pmo
管理战略|流程优化,流程|process optimization,process,workflow
管理战略|优化建议,建议|recommendation,recommendations,suggestion
管理战略|试点|pilot
管理战略|推广|rollout,roll out
管理战略|人力,排班|staffing,rostering,workforce
管理战略|资源分配,资源调度|resource allocation,scheduling,dispatch
管理战略|效率|efficiency
管理战略|协同|collaboration,collaborative
市场销售|市场|market,marketing
市场销售|客户|customer,client
市场销售|销售|sales
市场销售|竞争,竞争对手|competition,competitor
市场销售|商业零售,零售|retail,commercial retail
市场销售|品牌|brand,branding
市场销售|解决方案|solution,solutions
市场销售|产品|product
通用办公|概述,介绍,简介|overview,introduction,intro
通用办公|总结|summary,conclusion
通用办公|目录|agenda,contents
通用办公|附录|appendix
通用办公|谢谢|thank you,thanks,q&a
通用办公|视频|video
通用办公|统计|statistics,stats
通用办公|趋势|trend,trends
`;

const CATEGORY_NAMES = ['航空运营', '机场设施', '安全培训', '技术AI', '云与数据', '财务经营', '管理战略', '市场销售', '通用办公'];

const concepts = [];
const zhIndex = new Map(); // 中文词 -> concept
const enIndex = new Map(); // 英文词/短语(小写) -> concept

for (const line of RAW.split('\n')) {
  const t = line.trim();
  if (!t) continue;
  const [cat, zh, en] = t.split('|');
  const c = { id: concepts.length, cat, zh: zh.split(',').map((s) => s.trim()).filter(Boolean), en: en.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) };
  c.label = `${c.zh[0]}/${(en.split(',')[0] || '').trim()}`;
  concepts.push(c);
  for (const z of c.zh) if (!zhIndex.has(z)) zhIndex.set(z, c);
  for (const e of c.en) if (!enIndex.has(e)) enIndex.set(e, c);
}

const zhTerms = [...zhIndex.keys()].sort((a, b) => b.length - a.length);
const enPhrases = [...enIndex.keys()].filter((e) => /[\s-]/.test(e)).sort((a, b) => b.length - a.length);

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const enWordRe = new Map();
function enRe(term) {
  if (!enWordRe.has(term)) enWordRe.set(term, new RegExp(`(^|[^a-z0-9])${escapeRe(term)}([^a-z0-9]|$)`, 'i'));
  return enWordRe.get(term);
}

/** 在文本中查找词表概念，返回 [{concept, term, count}] */
function findConcepts(text) {
  const found = new Map();
  if (!text) return [];
  const lower = text.toLowerCase();
  for (const z of zhTerms) {
    if (z.length < 2) continue;
    let idx = lower.indexOf(z), n = 0;
    while (idx >= 0) { n++; idx = lower.indexOf(z, idx + z.length); }
    if (n) { const c = zhIndex.get(z); const f = found.get(c.id) || { concept: c, term: z, count: 0 }; f.count += n; found.set(c.id, f); }
  }
  for (const [e, c] of enIndex) {
    if (e.length < 2) continue;
    if (!lower.includes(e)) continue;
    const re = new RegExp(`(^|[^a-z0-9])${escapeRe(e)}(?=[^a-z0-9]|$)`, 'gi');
    const m = lower.match(re);
    if (m) { const f = found.get(c.id) || { concept: c, term: e, count: 0 }; f.count += m.length; found.set(c.id, f); }
  }
  return [...found.values()];
}

/** 将词翻译/扩展为同义词集合（中英双向） */
function expandTerm(term) {
  const t = term.trim();
  const lower = t.toLowerCase();
  const c = zhIndex.get(t) || enIndex.get(lower);
  if (c) return { concept: c, synonyms: [...new Set([...c.zh, ...c.en])] };
  return null;
}

module.exports = { concepts, findConcepts, expandTerm, zhTerms, enPhrases, enRe, CATEGORY_NAMES, zhIndex, enIndex };
