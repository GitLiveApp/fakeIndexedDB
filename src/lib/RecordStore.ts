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
    private readonly prefix: string;
    private readonly writeCache = new Map<string, any>()

    constructor(prefix: string) {
        this.prefix = `${prefix}.records`;
    }

    private recordKeys(): Array<string> {
        const memento = (indexedDB as unknown as FDBFactory).memento;
        return memento
            .keys()
            .filter((it) => it.startsWith(`${this.prefix}`))
            .map((it) => it.slice(this.prefix.length + 2, -2))
            .filter(it => this.writeCache.has(it) && this.writeCache.get(it) == undefined);
    }

    private getRecord(key: string): Record | undefined {
        const memento = (indexedDB as unknown as FDBFactory).memento;
        const value = this.writeCache.has(key) ? this.writeCache.get(key) : memento.get(`${this.prefix}['${key}']`);
        console.log(`get ${this.prefix}['${key}'] = ${JSON.stringify(value)}`);
        return value === undefined ? undefined : { key, value };
    }

    private updateRecord(record: Record) {
        const memento = (indexedDB as unknown as FDBFactory).memento;
        this.writeCache.set(record.key, record.value);
        memento.update(`${this.prefix}['${record.key}']`, record.value).then(undefined, it => console.error(it));
        console.log(`set ${this.prefix}['${record.key}'] = ${JSON.stringify(record.value)}`);
    }

    public get(key: Key | FDBKeyRange): Record | undefined {
        if (key instanceof FDBKeyRange) {
            return this.getRecord(getByKeyRange(this.recordKeys(), key)!!);
        }

        return this.getRecord(key);
    }

    public add(newRecord: Record) {
        this.updateRecord(newRecord);
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
            deletedRecords.push(this.getRecord(keys[idx])!);
            this.updateRecord({ key: keys[idx], value: undefined });
            keys.splice(idx, 1);
        }
        return deletedRecords;
    }

    public deleteByValue(key: Key) {
        const range = key instanceof FDBKeyRange ? key : FDBKeyRange.only(key);
        const deletedRecords: Record[] = [];

        for (key of this.recordKeys()) {
            const record = this.getRecord(key)!;
            if (range.includes(record.value)) {
                deletedRecords.push(record);
                this.updateRecord({ key: key, value: undefined });
            }
        }
        return deletedRecords;
    }

    public clear() {
        const deletedRecords: Record[] = [];

        for (const key of this.recordKeys()) {
            deletedRecords.push(this.getRecord(key)!);
            this.updateRecord({ key: key, value: undefined });
        }

        return deletedRecords;
    }

    public values(range?: FDBKeyRange, direction: "next" | "prev" = "next") {
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
