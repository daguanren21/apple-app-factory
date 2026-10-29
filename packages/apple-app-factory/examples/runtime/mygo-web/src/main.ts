import { Counter } from './mygo';
const count=document.querySelector<HTMLOutputElement>('#count')!;
const status=document.querySelector<HTMLParagraphElement>('#status')!;
async function change(delta:number){try{count.textContent=String(await Counter.change(delta));status.textContent='Saved';}catch(error){status.textContent=String(error);}}
document.querySelector<HTMLButtonElement>('#add')!.addEventListener('click',()=>void change(3));
document.querySelector<HTMLButtonElement>('#subtract')!.addEventListener('click',()=>void change(-10));
Object.assign(window,{smokeReady:false,runAcceptance:async(relaunch=false)=>{
 const wait=async(check:()=>boolean)=>{const until=Date.now()+10000;while(!check()){if(Date.now()>until)throw new Error('Visible UI transition timed out');const pending=Promise.withResolvers<void>();setTimeout(pending.resolve,20);await pending.promise;}};
 if(relaunch){if(count.textContent!=='3')throw new Error('Relaunch lost persisted total');}
 else{if(count.textContent!=='0')throw new Error('Fresh state must start at zero');document.querySelector<HTMLButtonElement>('#add')!.click();await wait(()=>count.textContent==='3'&&status.textContent==='Saved');}
 document.querySelector<HTMLButtonElement>('#subtract')!.click();await wait(()=>status.textContent!.includes('negative'));
 if(count.textContent!=='3')throw new Error('Rejected subtraction changed visible total');
 return {visibleTotal:Number(count.textContent),negativeRejected:true,error:status.textContent,goValue:await Counter.value()};
}});
const controls=[...document.querySelectorAll<HTMLButtonElement>('button')];
controls.forEach(control=>{control.disabled=true;});
count.textContent='Loading';
void Counter.value().then(value=>{
 count.textContent=String(value);
 status.textContent='Ready';
 controls.forEach(control=>{control.disabled=false;});
 Object.assign(window,{smokeReady:true});
},error=>{status.textContent=`Could not load saved counter: ${String(error)}`;});
