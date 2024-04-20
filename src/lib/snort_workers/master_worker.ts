import { seedRelays } from '@/snort_workers/seed_relays';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { NostrSystem, RequestBuilder, type QueryLike } from '@snort/system';
import { derived, writable } from 'svelte/store';
import WorkerPubkeys from './live_subs?worker';
import { Command, FrontendData, WorkerData } from './types';
import { execTime, followsFromKind3, getNostrEvent, tagSplits } from './utils';

let workerData = new WorkerData();
let workerDataStore = writable(workerData);

const sys = new NostrSystem({
	checkSigs: false
	// automaticOutboxModel: true,
	// buildFollowGraph: true,
});

let connecting = false

async function connect() {
	if (!connecting) {
		connecting = true
		seedRelays.forEach((r) => sys.ConnectToRelay(r, { read: true, write: false }));
	}
}

workerDataStore.subscribe((data) => {
	let end = execTime("28 workerDataStore.subscribe")
	let fed = new FrontendData();
	fed.basePubkey = data.ourPubkey();
	fed.baseFollows = data._ourFollows;
	let roots: NostrEvent[] = [];
	for (let r of data.roots) {
		let re = data.events.get(r);
		if (!r) {
			throw new Error('missing event, this should not happen, bug!');
		}
		roots.push(re!);
	}
	fed.roots = roots.toSorted((a, b) => {
		let a_replies = data.replies.get(a.id!);
		let b_replies = data.replies.get(b.id!);
		if (a_replies && b_replies) {
			return b_replies.size - a_replies.size;
		}
		if (!a_replies && b_replies) {
			return 1;
		}
		if (!b_replies && a_replies) {
			return -1;
		}
		return 0;
	});
	fed.replies = data.replies;
	fed.rawEvents = data.events;
	postMessage(fed);
	end()
});

let lengthOfFollows = derived(workerDataStore, ($wds) => {
	return $wds._ourFollows.size;
});


let q_subToFollows: QueryLike
lengthOfFollows.subscribe((x) => {
	console.log('follows updated');
	if (x > 0) {
		const rb = new RequestBuilder('sub-to-follows');
		rb.withFilter().authors([...workerData._ourFollows]).kinds([1])
		rb.withOptions({ leaveOpen: true });
		if (q_subToFollows) {q_subToFollows.cancel()}
		q_subToFollows = sys.Query(rb);
		q_subToFollows.on('event', (evs): void => {
			let m = new Map<string, NostrEvent>()
			for (let e of evs) {
				m.set(e.id, e)
			}
			if (m.size > 0) {
				updateReplies(m)
			}
		})
	}
});

//contract:
onmessage = (m: MessageEvent<Command>) => {
	let end = execTime("88, onmessage")
	if (m.data.command == 'start') {
		start(m.data.pubkey)
	}
	if (m.data.command == 'push_event') {
		console.log(96)
		let map = new Map<string, NostrEvent>()
		if (m.data.event) {
			for (let e of m.data.event) {
				map.set(e.id, e)
			}
			if (map.size > 0) {
				console.log(89, map)
				updateReplies(map)
				console.log(91)
			}
		}
	}
	end()
};

//connect to seed relays, get our follows and relays.
async function start(pubkey?: string, pubkeys?: string[]) {
	connect()
	return new Promise((resolve, reject) => {
		if (pubkey) {
			workerData.setOurPubkey(pubkey);
		} else {
			pubkey = workerData.ourPubkey();
		}
		
		(async () => {
			const rb = new RequestBuilder('fetch-initial-data');
			let _pukeys: string[] = [];
			if (pubkeys) {
				_pukeys = pubkeys;
			}
			if (pubkey) {
				_pukeys.push(pubkey);
			}
			rb.withFilter().authors(_pukeys).kinds([3, 10002]);
			rb.withOptions({ leaveOpen: false });

			const q = sys.Query(rb);
			q.on('event', (evs): void => {
				let updated = new Set<string>();
				for (let e of evs) {
					//todo: get all relays from all follows (3, 10002)
					let eNt = getNostrEvent(e);
					let latestForPubkey = workerData.latestReplaceable.get(e.pubkey);
					if (!latestForPubkey) {
						latestForPubkey = new Map();
					}
					let latestForDedupKey = latestForPubkey.get(e.kind.toString(10));

					if (!latestForDedupKey) {
						updated.add(eNt.pubkey);
						latestForDedupKey = eNt;
					}
					if (latestForDedupKey.created_at < eNt.created_at) {
						updated.add(eNt.pubkey);
						latestForDedupKey = eNt;
					}
					latestForPubkey.set(latestForDedupKey.kind.toString(10), latestForDedupKey);
					workerData.latestReplaceable.set(e.pubkey, latestForPubkey);
				}
				let dirty = false;
				for (let pubkey of updated) {
					if (pubkey == workerData.ourPubkey()) {
						let event = workerData.latestReplaceable.get(pubkey)?.get('3');
						if (event) {
							let follows = followsFromKind3(event);
							if (follows.size > 0) {
								workerData.setOurFollows(follows);
								dirty = true;
							}
						}
					}
				}
				if (dirty) {
					workerDataStore.update((d) => {
						return d;
					});
				}
				//todo: get all relays from all follows (3, 10002)
			});
		})();
	});
}
//live sub to all our follows (last 24 hours of events)
//live process all events into map of roots and replies
//sub to all roots
//fetch all missing roots
//sort roots by number of responses from our follows

//let permaSub: Worker | undefined = undefined;

function updateReplies(newEvents?:Map<string, NostrEvent>) {
	workerDataStore.update((current) => {
		let end = execTime("updateReplies")
		if (newEvents) {
			current.events = new Map([...newEvents, ...current.events]);
		}
		//console.log(current.events.size)
		let printed = 0;
		let printedID = new Set<string>();
		for (let [id, e] of current.events) {
			current.missingEvents.delete(id);
			let tagsForEvent = new tagSplits(e);
			if (tagsForEvent.unknown.size > 0) {
				//tell user that there's an unhandled tag
				if (printed < 20 && !printedID.has(tagsForEvent.id)) {
					printed++;
					printedID.add(tagsForEvent.id);
					//console.log('unknown tag detected', printed, tagsForEvent.rawEvent);
				}
			}
			tagsForEvent.roots.forEach((r) => {
				if (!current.events.has(r)) {
					current.missingEvents.add(r);
				} else {
					current.roots.add(r);
				}
			});
			if (
				(tagsForEvent.replies.size != 1 && tagsForEvent.unlabelled.size > 1) ||
				tagsForEvent.replies.size > 1
			) {
				//we don't know which tag is the _real_ reply (parent), let's try and find out
				let possibleParents = new Map<string, NostrEvent>();
				let possibleReplyTags = new Set([...tagsForEvent.unlabelled, ...tagsForEvent.replies]);
				let numMissing = 0;
				for (let _id of possibleReplyTags) {
					let _event = current.events.get(_id);
					if (_event) {
						possibleParents.set(_id, _event);
					}
					if (!_event) {
						current.missingEvents.add(_id);
						numMissing++;
					}
				}
				if (numMissing == 0 && possibleParents.size > 0) {
					let allTaggedEvents = new Set<string>();
					for (let [_, e] of possibleParents) {
						let splits = new tagSplits(e);
						for (let id of splits.All()) {
							allTaggedEvents.add(id);
						}
					}
					let tagsThatAreNotInTaggedEvents = new Set<string>();
					for (let id of possibleReplyTags) {
						if (!allTaggedEvents.has(id)) {
							tagsThatAreNotInTaggedEvents.add(id);
						}
					}
					if (tagsThatAreNotInTaggedEvents.size == 1) {
						//console.log("found mistagged reply")
						tagsForEvent.replies = new Set([tagsThatAreNotInTaggedEvents][0]);
					}
					//if more than one in replies: find all the tagged events and see which tag among all these events is unique (the unique one is probably the reply, and the repeated one(s) are the root or further up in the thread)
					//console.log('implement me');
				} else {
					//console.log(missing)
					//todo: fetch missing events by ID
				}
			}
			if (tagsForEvent.replies.size == 1) {
				let existing = current.replies.get([...tagsForEvent.replies][0]);
				if (!existing) {
					existing = new Set();
				}
				existing.add(tagsForEvent.id);
				current.replies.set([...tagsForEvent.replies][0], existing);
			}
		}
		end()
		return current;
	});
}



// async function PermaSub(pubkeys: string[]) {
// 	if (pubkeys.length > 0) {


// 		if (permaSub) {
// 			permaSub.terminate();
// 		}
// 		permaSub = new WorkerPubkeys();
// 		permaSub.onmessage = (x: MessageEvent<Map<string, NostrEvent>>) => {
// 			updateReplies(x.data)
// 		};
// 		let cmd = new Command('sub_to_pubkeys');
// 		cmd.pubkeys = pubkeys;
// 		permaSub.postMessage(cmd);
// 	}
// }

let numberOfMissingEvents = derived(workerDataStore, ($wds) => {
	return $wds.missingEvents.size;
});

//let fetchEventsWorker: Worker | undefined = undefined;


 
let q_missingEvents: QueryLike
numberOfMissingEvents.subscribe((n) => {
	let end = execTime("298 numberOfMissingEvents")
	if (n > 0) {
		const rb = new RequestBuilder('fetch-missing-events');
		rb.withFilter().ids([...workerData.missingEvents])
		rb.withOptions({ leaveOpen: false });
		if (q_missingEvents) {q_missingEvents.cancel()}
		q_missingEvents = sys.Query(rb);
		q_missingEvents.on('event', (evs): void => {
			let m = new Map<string, NostrEvent>()
			for (let e of evs) {
				m.set(e.id, e)
			}
			if (m.size > 0) {
				updateReplies(m)
			}
		})
	}
	end()
});



export default {};
