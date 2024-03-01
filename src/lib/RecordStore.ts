import type FDBFactory from "../FDBFactory.js";
import FDBKeyRange from "../FDBKeyRange.js";
import {
    getByKeyRange,
    getIndexByKey,
    getIndexByKeyGTE,
    getIndexByKeyRange,
} from "./binarySearch.js";
import cmp from "./cmp.js";
import { Key, Record } from "./types.js";

class RecordStore {
    constructor(private readonly name: string) {}

    private recordKeys(): Array<string> {
        const memento = (indexedDB as unknown as FDBFactory).memento;
        return memento
            .keys()
            .filter((it) => it.startsWith(`${this.name}.`))
            .map((it) => it.substring(this.name.length + 1));
    }

    private getRecord(key: string): Record {
        const memento = (indexedDB as unknown as FDBFactory).memento;
        return { key: key, value: memento.get(`${this.name}.${key}`) };
    }

    private updateRecord(record: Record) {
        const memento = (indexedDB as unknown as FDBFactory).memento;
        memento.update(`${this.name}.${record.key}`, record.value);
    }

    private assertSorted() {
        const keys = this.recordKeys();
        const sortedKeys = keys.sort((a, b) => a.localeCompare(b));
        for (const idx in keys) {
            if (keys[idx] !== sortedKeys[idx])
                throw Error(`${keys[idx]} !== ${sortedKeys[idx]}`);
        }
    }

    public get(key: Key | FDBKeyRange): Record {
        this.assertSorted();
        if (key instanceof FDBKeyRange) {
            return this.getRecord(getByKeyRange(this.recordKeys(), key)!!);
        }

        return this.getRecord(key);
    }

    public add(newRecord: Record) {
        this.updateRecord(newRecord);
        this.assertSorted();
    }

    public delete(key: Key) {
        const deletedRecords: Record[] = [];
        const keys = this.recordKeys();
        const isRange = key instanceof FDBKeyRange;
        while (true) {
            const idx = isRange
                ? getIndexByKeyRange(keys, key)
                : getIndexByKey(keys, key);
            if (idx === -1) {
                break;
            }
            deletedRecords.push(this.getRecord(keys[idx]));
            this.updateRecord({ key: keys[idx], value: undefined });
            keys.splice(idx, 1);
        }
        this.assertSorted();
        return deletedRecords;
    }

    public deleteByValue(key: Key) {
        const range = key instanceof FDBKeyRange ? key : FDBKeyRange.only(key);
        const deletedRecords: Record[] = [];

        for (key of this.recordKeys()) {
            const record = this.getRecord(key);
            if (range.includes(record.value)) {
                deletedRecords.push(record);
                this.updateRecord({ key: key, value: undefined });
            }
        }
        this.assertSorted();
        return deletedRecords;
    }

    public clear() {
        const deletedRecords: Record[] = [];

        for (const key of this.recordKeys()) {
            deletedRecords.push(this.getRecord(key));
            this.updateRecord({ key: key, value: undefined });
        }

        return deletedRecords;
    }

    public values(range?: FDBKeyRange, direction: "next" | "prev" = "next") {
        this.assertSorted();
        const keys = this.recordKeys();
        return {
            [Symbol.iterator]: () => {
                let i: number;
                if (direction === "next") {
                    i = 0;
                    if (range !== undefined && range.lower !== undefined) {
                        while (keys[i] !== undefined) {
                            const cmpResult = cmp(keys[i], range.lower);
                            if (
                                cmpResult === 1 ||
                                (cmpResult === 0 && !range.lowerOpen)
                            ) {
                                break;
                            }
                            i += 1;
                        }
                    }
                } else {
                    i = keys.length - 1;
                    if (range !== undefined && range.upper !== undefined) {
                        while (keys[i] !== undefined) {
                            const cmpResult = cmp(keys[i], range.upper);
                            if (
                                cmpResult === -1 ||
                                (cmpResult === 0 && !range.upperOpen)
                            ) {
                                break;
                            }
                            i -= 1;
                        }
                    }
                }

                return {
                    next: () => {
                        let done;
                        let value;
                        if (direction === "next") {
                            value = { key: keys[i] };
                            done = i >= keys.length;
                            i += 1;

                            if (
                                !done &&
                                range !== undefined &&
                                range.upper !== undefined
                            ) {
                                const cmpResult = cmp(value.key, range.upper);
                                done =
                                    cmpResult === 1 ||
                                    (cmpResult === 0 && range.upperOpen);
                                if (done) {
                                    value = undefined;
                                }
                            }
                        } else {
                            value = { key: keys[i] };
                            done = i < 0;
                            i -= 1;

                            if (
                                !done &&
                                range !== undefined &&
                                range.lower !== undefined
                            ) {
                                const cmpResult = cmp(value.key, range.lower);
                                done =
                                    cmpResult === -1 ||
                                    (cmpResult === 0 && range.lowerOpen);
                                if (done) {
                                    value = undefined;
                                }
                            }
                        }

                        // The weird "as IteratorResult<Record>" is needed because of
                        // https://github.com/Microsoft/TypeScript/issues/11375 and
                        // https://github.com/Microsoft/TypeScript/issues/2983
                        return {
                            done,
                            value: value && this.getRecord(value.key),
                        } as IteratorResult<Record>;
                    },
                };
            },
        };
    }
}

export default RecordStore;
