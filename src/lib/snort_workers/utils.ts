import { NDKEvent, type NostrEvent } from '@nostr-dev-kit/ndk';
import type { TaggedNostrEvent } from '@snort/system';
import type { Event } from 'nostr-tools';
import { FrontendData, WorkerData } from './types';
import { BloomFilter } from 'bloomfilter';
import { Rake } from '@/rake/rake';

let debug = false

export let execTime = (name: string): (() => void) => {
	let start = performance.now();
	let ended = false;
	setTimeout(() => {
		if (!ended) {
			console.log(name, 'has timed out');
		}
	}, 5000);
	return () => {
		let end = performance.now();
		ended = true;
        if (debug) {
            console.log(name, end - start, 'ms');
        }
		
	};
};

export function getNostrEvent(ev: TaggedNostrEvent): Event {
	return {
		id: ev.id,
		created_at: ev.created_at,
		content: ev.content,
		tags: ev.tags,
		pubkey: ev.pubkey,
		sig: ev.sig,
		kind: ev.kind
	};
}

export function followsFromKind3(event: Event): Set<string> {
	return new Set(event.tags.filter((t) => t[0] == 'p').map((t) => t[1]));
}

export function bloomFromKind18100(event: Event): BloomFilter | undefined {
	let eNDK = new NDKEvent(undefined, event)
	let bloomString = eNDK.getMatchingTags("bloom")
	if (bloomString.length == 1) {
		//console.log(JSON.parse(bloomString[0][bloomString[0].length-1]))
		//console.log(JSON.parse(bloomString[0]))
		let b = new BloomFilter(JSON.parse(bloomString[0][bloomString[0].length-1]), 32)
		if (b) {
			return b
		}
	}
	return undefined
}

export class tagSplits {
	id: string;
	rawEvent: NostrEvent;
	thisIsRoot: boolean;
	roots: Set<string>;
	replies: Set<string>;
	mentions: Set<string>;
	unlabelled: Set<string>;
	unknown: Set<string>;
	All(): Set<string> {
		return new Set([...this.roots, ...this.replies, ...this.mentions, ...this.unlabelled, ...this.unknown]);
	}
	constructor(event: NostrEvent) {
		this.rawEvent = event;
		let ndk_event = new NDKEvent(undefined, event);
		this.id = ndk_event.id;
		this.roots = new Set<string>();
		this.replies = new Set<string>();
		this.mentions = new Set<string>();
		this.unlabelled = new Set<string>();
		this.unknown = new Set<string>();
		this.thisIsRoot = true;
		let tags = ndk_event.getMatchingTags('e');
		for (const [i, tag] of tags.entries()) {
			if (tag[1] && tag[1].length == 64) {
				if (tag.includes('root')) {
					this.roots.add(tag[1]);
					this.thisIsRoot = false;
				} else if (tag.includes('mention')) {
					this.mentions.add(tag[1]);
				} else if (tag.includes('reply')) {
					this.replies.add(tag[1]);
					this.thisIsRoot = false;
				} else if (
					tag.length == 2 ||
					tag[tag.length - 1] == '' ||
					tag[tag.length - 1].includes('://')
				) {
					this.unlabelled.add(tag[1]);
					this.thisIsRoot = false;
				} else {
					this.unknown.add(tag[1]);
				}
			}
		}
		if (this.replies.size == 0 && this.unlabelled.size == 1) {
			this.replies.add([...this.unlabelled][0]);
		}
		if (this.replies.size == 0 && this.roots.size == 1) {
			this.replies.add([...this.roots][0]);
		}
	}
}

export function updateRepliesInPlace(current: FrontendData | WorkerData) {
	let end = execTime('updateRepliesInPlace');
	let printed = 0;
	let printedID = new Set<string>();
	for (let [id, e] of current.events) {
        if (e.kind == 18100) {console.log(117, e)}
		if (current instanceof WorkerData) {
			current.missingEvents.delete(id);
		}
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
			if (current instanceof WorkerData) {
				if (!current.events.has(r)) {
					current.missingEvents.add(r);
				} else {
					current.roots.add(r);
				}
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
					if (current instanceof WorkerData) {
						current.missingEvents.add(_id);
					}
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
				//todo: fetch missing events by ID? or fuck it?
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
		if (current instanceof WorkerData) {
			if (e.pubkey == current.ourPubkey()) {
				for (let id of tagsForEvent.All()) {
					let ev = current.events.get(id)
					if (ev && ev.kind == 1) {
						if (!current.rake.processedThisSession.has(ev.id)) {
							current.rake.processedThisSession.add(ev.id);
							for (let w of rakeIt(ev.content)) {
								let existing = current.rake.words.get(w)
								if (!existing) {
									existing = 0
								}
								existing++
								current.rake.words.set(w, existing)
							}
						}
					}
					current.ourBloom.add(id);
					current.bloomSize++;
				}
			}
		}
	}
	end();
}

function rakeIt(text: string) {
const rakeInstance = new Rake();
return  rakeInstance.extractKeywords(text);
}