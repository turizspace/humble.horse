import { currentPubkey } from '@/stores/user';
import { get, writable, type Writable } from 'svelte/store';
import { Command, FrontendData } from './firehose.types';


export let responseFromWorker: Writable<FrontendData> = writable(new FrontendData());
export let viewed: Writable<Set<string>> = writable(new Set());
let initted = false
export function Init() {
    if (!initted) {
        setupWorker();
    }

}

let firehoseWorker: Worker | undefined = undefined;

const onWorkerMessage = (x: MessageEvent<FrontendData>) => {
	// if (!responseFromWorker) {
	// 	responseFromWorker = writable(x.data);
	// }
	responseFromWorker.update((current) => {
		current = x.data;
		return current;
	});
};
let WorkerStarted = false;

let setupWorker = async () => {
	if (!WorkerStarted) {
		WorkerStarted = true;
		const w = await import('./firehose.ts?worker');
		firehoseWorker = new w.default();
		firehoseWorker.onmessage = onWorkerMessage;
		firehoseWorker.postMessage(connect);
        console.log(30)
	}
};

let start: Command = {
	command: 'start',
	pubkey: 'd91191e30e00444b942c0e82cad470b32af171764c2275bee0bd99377efd4075'
};

currentPubkey.subscribe(pubkey=>{
    if (pubkey && firehoseWorker) {
        firehoseWorker.postMessage({
            command: 'start',
            pubkey: pubkey
        })
    }
})

let connect: Command = {
	command: 'connect',
    pubkey: get(currentPubkey) || 'd91191e30e00444b942c0e82cad470b32af171764c2275bee0bd99377efd4075'
};

let rootPubkey = 'd91191e30e00444b942c0e82cad470b32af171764c2275bee0bd99377efd4075';