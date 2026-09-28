"""Generate the proposed README's three CSS-only motion studies.

Usage: python3 .misc/animations/landing.py [output-directory]
The desktop and mobile compositions are deliberately different: text remains
readable in GitHub's narrow README column. Static/reduced-motion is the final
state. No scripts, remote fonts, or external resources are needed by the SVGs.
"""
from pathlib import Path
from html import escape
import sys

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / 'docs/images'
OUT.mkdir(parents=True, exist_ok=True)

THEME = '''
:root { --bg:#ffffff; --ink:#242329; --muted:#66616f; --line:#ddd9e4; --surface:#f7f5fa; --paper:#ffffff; --accent:#6b49c8; --accent-soft:#f0eafa; --good:#177c67; --good-soft:#eaf6f1; --warn:#9a5b16; --warn-soft:#fff3e1; }
@media(prefers-color-scheme:dark) { :root { --bg:#0d1117; --ink:#eceaf1; --muted:#aaa5b5; --line:#35333f; --surface:#181920; --paper:#11151c; --accent:#b7a0ff; --accent-soft:#272038; --good:#75d8ba; --good-soft:#132b25; --warn:#edc084; --warn-soft:#33291c; } }
svg { background:var(--bg); }
text { fill:var(--ink); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; font-size:18px; font-weight:400; }
.label { font-size:12px; font-weight:600; letter-spacing:1.6px; fill:var(--muted); }
.small { font-size:15px; fill:var(--muted); }
.name { font-size:20px; font-weight:600; letter-spacing:-.4px; }
.mono { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:14px; fill:var(--muted); }
.box { fill:var(--paper); stroke:var(--line); stroke-width:1; }
.surface { fill:var(--surface); stroke:var(--line); stroke-width:1; }
.accent-box { fill:var(--accent-soft); stroke:var(--accent); stroke-width:1; }
.good-box { fill:var(--good-soft); stroke:none; }
.warn-box { fill:var(--warn-soft); stroke:none; }
.accent { fill:var(--accent); } .good { fill:var(--good); } .warn { fill:var(--warn); }
.wire { fill:none; stroke:var(--line); stroke-width:1.6; }
.signal { fill:none; stroke:var(--accent); stroke-width:2; }
.trace { fill:none; stroke:var(--accent); stroke-width:3; stroke-linecap:round; stroke-dasharray:8 100; stroke-dashoffset:108; }
.tick { fill:none; stroke:var(--good); stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
.phase-1,.phase-2 { opacity:0; } .phase-3 { opacity:1; }
.compact { opacity:0; }
@media(prefers-reduced-motion:no-preference) {
 .phase-1 { animation:phase-one 15s linear infinite; }
 .phase-2 { animation:phase-two 15s linear infinite; }
 .phase-3 { animation:phase-three 15s linear infinite; }
 .send { animation:send 15s linear infinite; }
 .receive { animation:receive 15s linear infinite; }
 .signal-flow { animation:signal-flow 15s linear infinite; }
 .work { transform-box:fill-box; transform-origin:left center; animation:work 15s linear infinite; }
 .record { animation:record 15s linear infinite; }
 .compact { transform-box:fill-box; transform-origin:left center; animation:compact 15s ease-in-out infinite; }
 .show-summary { animation:show-summary 15s ease-in-out infinite; }
}
@keyframes phase-one { 0%,27%{opacity:1} 29%,97%{opacity:0} 100%{opacity:1} }
@keyframes phase-two { 0%,29%{opacity:0} 31%,60%{opacity:1} 62%,100%{opacity:0} }
@keyframes phase-three { 0%,62%{opacity:0} 64%,95%{opacity:1} 97%,100%{opacity:0} }
@keyframes send { 0%,6%{stroke-dashoffset:108;opacity:0} 7%{opacity:1} 17%{stroke-dashoffset:0;opacity:1} 18%,100%{opacity:0} }
@keyframes receive { 0%,17%{stroke-dashoffset:108;opacity:0} 18%{opacity:1} 27%{stroke-dashoffset:0;opacity:1} 28%,100%{opacity:0} }
@keyframes signal-flow { 0%,35%{stroke-dashoffset:108;opacity:0} 36%{opacity:1} 52%{stroke-dashoffset:0;opacity:1} 53%,100%{opacity:0} }
@keyframes work { 0%,18%{transform:scaleX(.12)} 58%,95%{transform:scaleX(1)} 100%{transform:scaleX(.12)} }
@keyframes record { 0%,5%{opacity:.25} 20%,100%{opacity:1} }
@keyframes compact { 0%,28%{transform:scaleX(1);opacity:1} 48%,95%{transform:scaleX(.2);opacity:0} 98%,100%{transform:scaleX(1);opacity:1} }
@keyframes show-summary { 0%,38%{opacity:0} 49%,95%{opacity:1} 98%,100%{opacity:0} }
'''

class Drawing:
    def __init__(self, width, height, title, desc):
        self.width, self.height, self.title, self.desc = width,height,title,desc
        self.parts=[]
    def add(self,s): self.parts.append(s)
    def text(self,x,y,s,cls='',anchor='start'):
        self.add(f'<text x="{x}" y="{y}" class="{cls}" text-anchor="{anchor}">{escape(s)}</text>')
    def rect(self,x,y,w,h,cls='box',r=12):
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" class="{cls}"/>')
    def path(self,d,cls='wire',extra=''):
        self.add(f'<path d="{d}" class="{cls}" {extra}/>')
    def group(self,cls): self.add(f'<g class="{cls}">')
    def end(self): self.add('</g>')
    def state(self,x,y,labels,cls='small',anchor='start'):
        for i,label in enumerate(labels,1):
            self.group(f'phase-{i}');self.text(x,y,label,cls,anchor);self.end()
    def phases(self,labels,mobile=False):
        self.text(24 if mobile else 32,31,'THE AGENT, IN MOTION','label')
        self.state(self.width-(24 if mobile else 32),31,[f'0{i} / {label}' for i,label in enumerate(labels,1)],'mono','end')
    def tick(self,x,y): self.path(f'M{x} {y} l4 4 l8 -9','tick')
    def write(self,name):
        svg=f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.width}" height="{self.height}" viewBox="0 0 {self.width} {self.height}" role="img" aria-labelledby="title desc"><title id="title">{escape(self.title)}</title><desc id="desc">{escape(self.desc)}</desc><style>{THEME}</style>\n'+ '\n'.join(self.parts)+'\n</svg>\n'
        (OUT / name).write_text(svg)
        # Explicit still assets let <picture> honor reduced-motion even where
        # a browser does not pass that preference into an SVG image document.
        still = svg.replace('</style>', 'svg * { animation:none!important; }</style>')
        (OUT / name.replace('.svg','-still.svg')).write_text(still)

def control(mobile=False):
    d=Drawing(380 if mobile else 800,640 if mobile else 416,'Responsive control, durable work','A controller acknowledges a request and starts a turn. New steering reaches the next model step while the current tools finish. The controller remains available throughout.')
    if mobile:
        d.text(24,30,'RESPONSIVE CONTROL','label')
        d.state(24,59,['01 / Start','02 / Steer','03 / Continue'],'mono')
        d.rect(24,84,332,88)
        d.text(42,109,'YOUR MESSAGE','label')
        d.state(42,142,['Plan a Berlin trip','Only direct flights','Only direct flights'],'name')
        d.path('M190 172 V204');d.path('M190 172 V204','trace send', 'pathLength="100"')
        d.rect(24,204,332,82,'accent-box');d.text(42,232,'CONTROLLER · Agent','label')
        d.text(42,262,'Acknowledged.','name');d.text(335,262,'✓','good','end')
        d.path('M190 286 V330');d.path('M190 286 V330','trace signal-flow','pathLength="100"')
        d.rect(24,330,332,234,'surface');d.text(42,357,'TURN · AgentSession.doTurn','label')
        d.rect(42,376,296,47);d.text(58,406,'Model proposes tools','small')
        d.rect(42,435,296,47);d.text(58,465,'Weather + flight search','small')
        d.rect(58,473,264,3,'accent work',1)
        d.rect(42,494,296,49,'accent-box')
        d.state(58,525,['Next model step','Steering is waiting','Uses results + steering'],'small')
        d.state(24,602,['Start work. Keep listening.','Tools finish without cancellation.','Continue with the new direction.'],'small')
    else:
        d.phases(['Start','Steer','Continue'])
        d.rect(32,76,216,82);d.text(50,101,'YOUR MESSAGE','label')
        d.state(50,134,['Plan a Berlin trip','Only direct flights','Only direct flights'],'name')
        d.path('M248 117 H304');d.path('M248 117 H304','trace send','pathLength="100"')
        d.rect(304,76,208,82,'accent-box');d.text(324,102,'CONTROLLER','label');d.text(324,134,'Agent','name')
        d.path('M512 117 H576');d.path('M512 117 H576','trace receive','pathLength="100"')
        d.rect(576,96,192,42,'good-box');d.tick(593,117);d.text(616,124,'Acknowledged','small')
        d.path('M408 158 V196');d.path('M408 158 V196','trace signal-flow','pathLength="100"')
        d.rect(32,196,736,148,'surface');d.text(52,226,'TURN · AgentSession.doTurn','label')
        d.rect(52,248,154,70);d.text(70,277,'Model','name');d.text(70,302,'proposes tools','small')
        d.path('M206 283 H254');d.path('M206 283 H254','trace send','pathLength="100"')
        d.rect(254,248,240,70);d.text(272,276,'Weather + flight search','small')
        d.rect(272,292,204,5,'surface',2);d.rect(272,292,204,5,'accent work',2)
        d.path('M494 283 H558');d.path('M494 283 H558','trace signal-flow','pathLength="100"')
        d.rect(558,248,190,70,'accent-box');d.text(576,277,'Next model step','name')
        d.state(576,303,['reads tool results','steering is waiting','uses steering too'],'small')
        d.state(32,385,['Start the turn. The controller stays available.','Steer while tools run. Their work is preserved.','The next model step uses the new direction.'],'small')
    d.write('landing-control'+('-mobile' if mobile else '')+'.svg')

def recovery(mobile=False):
    d=Drawing(380 if mobile else 800,556 if mobile else 354,'Recorded work survives a restart','Model and tool results are recorded in Restate. When the service restarts, recorded results are reused and the turn continues. External effects not recorded before a crash may still repeat.')
    if mobile:
        d.text(24,30,'DURABLE EXECUTION','label');d.state(24,59,['01 / Record','02 / Restart','03 / Resume'],'mono')
        d.rect(24,87,332,86,'surface');d.text(42,112,'SERVICE PROCESS','label')
        d.state(42,148,['Running','Restarting…','Running again'],'name')
        d.rect(24,202,332,214);d.text(42,232,'JOURNAL · stored in Restate','label')
        for y,name in [(250,'Model response'),(301,'Tool result')]:
            d.rect(42,y,296,39,'good-box');d.tick(59,y+20);d.text(82,y+25,name,'small')
        d.state(42,391,['Results recorded','Results stay here','Recorded results reused'],'small')
        d.path('M190 173 V202');d.path('M190 416 V445')
        d.rect(24,445,332,55,'accent-box');d.state(42,479,['Next unfinished step','Waiting for the process','Continue from here'],'name')
        d.text(24,536,'Reuse completed work. Continue the turn.','small')
    else:
        d.phases(['Record','Restart','Resume'])
        d.rect(32,76,736,72,'surface');d.text(52,106,'SERVICE PROCESS','label')
        d.state(52,131,['Running','Restarting…','Running again'],'small')
        for i,label in enumerate(['Work','Restart','Continue']):
            x=348+i*136;d.rect(x,93,120,38,'box');d.text(x+60,118,label,'small','middle')
            d.group(f'phase-{i+1}');d.rect(x,93,120,38,'accent-box');d.text(x+60,118,label,'small','middle');d.end()
        d.path('M400 148 V180')
        d.text(32,195,'JOURNAL · stored in Restate','label')
        for x,label in [(32,'Model response'),(278,'Tool result')]:
            d.rect(x,214,224,64,'good-box');d.tick(x+19,246);d.text(x+45,244,label,'small')
            d.state(x+45,263,['recorded','preserved','reused'],'mono')
        d.path('M502 246 H544')
        d.rect(544,214,224,64,'accent-box');d.text(564,242,'Next unfinished step','small')
        d.state(564,263,['ready to run','waiting','continues'],'mono')
        d.state(32,324,['Record each result as the turn runs.','The process stops. Recorded work stays.','Reuse the recorded results and keep going.'],'small')
    d.write('landing-recovery'+('-mobile' if mobile else '')+'.svg')

def compaction(mobile=False):
    d=Drawing(380 if mobile else 800,546 if mobile else 350,'A smaller context, an intact history','The conversation log stays append-only. Older exchanges become a background summary; eight recent exchanges remain verbatim in the model context. In-turn context compaction is a separate, blocking operation.')
    if mobile:
        d.text(24,30,'BACKGROUND COMPACTION','label');d.state(24,59,['01 / Accumulate','02 / Summarize','03 / Reuse'],'mono')
        d.text(24,104,'CONVERSATION LOG','label');d.text(24,132,'Full history, kept intact','name')
        for i in range(16): d.rect(24+i*21,151,15,30,'accent' if i>=8 else 'surface',3)
        d.text(24,211,'Older exchanges','small');d.text(356,211,'8 recent','small','end')
        d.path('M337 233 V283')
        d.text(24,267,'Summarize in the background','small')
        d.text(24,316,'MODEL CONTEXT','label')
        d.group('compact')
        for i in range(8):d.rect(24+(i%4)*39,337+(i//4)*45,30,36,'surface',4)
        d.end()
        d.group('show-summary');d.rect(24,337,150,84,'accent-box')
        d.text(42,370,'Summary','name');d.text(42,399,'older exchanges','small')
        d.end()
        d.text(190,386,'+','name')
        for i in range(8): d.rect(213+(i%4)*34,337+(i//4)*45,26,36,'accent',4)
        d.text(24,468,'Recent exchanges stay verbatim.','small');d.text(24,496,'The log is never rewritten.','small')
    else:
        d.phases(['Accumulate','Summarize','Reuse'])
        d.text(32,83,'CONVERSATION LOG','label');d.text(768,83,'append-only','mono','end')
        for i in range(16):d.rect(32+i*46,102,34,36,'accent' if i>=8 else 'surface',5)
        d.text(32,165,'Older exchanges','small');d.text(408,165,'8 recent exchanges','small')
        d.path('M190 178 V233');d.path('M578 178 V233')
        d.text(32,213,'MODEL CONTEXT','label')
        d.group('compact')
        for i in range(8):d.rect(32+i*40,233,31,62,'surface',5)
        d.end()
        d.group('show-summary');d.rect(32,233,292,62,'accent-box');d.text(52,260,'Summary','name');d.text(52,282,'written in the background','small');d.end()
        d.text(358,270,'+','name')
        for i in range(8):d.rect(408+i*45,233,33,62,'accent',5)
        d.state(32,331,['History grows. The most recent exchanges stay separate.','Summarize older exchanges without holding up the next turn.','A compact summary + recent exchanges. The log stays intact.'],'small')
    d.write('landing-context'+('-mobile' if mobile else '')+'.svg')

for mobile in [False,True]:
    control(mobile);recovery(mobile);compaction(mobile)
print(f'Generated six animations and six reduced-motion stills in {OUT}')
