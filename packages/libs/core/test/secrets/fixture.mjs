import {runHandler} from "../ptc/harness.mjs";

export function objectFixture(service,{key="user-a",state=new Map(),rpc=()=>null,now=1000}={}) {
  const effects=[];
  const invoke=(method,input,replay=[])=>runHandler(async ctx=>{
    let seq=0;
    const proxy=new Proxy(ctx,{get(target,property){
      if(property==="key")return key;
      if(property==="get")return name=>ctx.run(`get-${seq++}`,()=>structuredClone(state.get(name)??null));
      if(property==="set")return (name,value)=>{state.set(name,structuredClone(value));effects.push({set:name,value});};
      if(property==="clear")return name=>state.delete(name);
      if(property==="date")return {now:()=>ctx.run(`now-${seq++}`,()=>now)};
      if(property==="genericCall" || property==="genericSend")return opts=>{
        effects.push(opts);
        const invocationId=ctx.run(`rpc-id-${seq++}`,()=>"turn-1");
        if(property==="genericSend")return {invocationId};
        return Object.assign(ctx.run(`rpc-${seq++}`,()=>rpc(opts)),{invocationId});
      };
      if(property==="invocation")return id=>({signal:name=>({resolve:value=>effects.push({id,signal:name,value})})});
      const value=Reflect.get(target,property);return typeof value==="function"?value.bind(target):value;
    }});
    try {return {value:(await service.object[method](proxy,input))??null};}
    catch(error){return {error:error.message};}
  },{replay});
  return {invoke,state,effects};
}
