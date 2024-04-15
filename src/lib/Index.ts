import FDBKeyRange from "../FDBKeyRange.js";
import FDBTransaction from "../FDBTransaction.js";
import { ConstraintError } from "./errors.js";
import extractKey from "./extractKey.js";
import ObjectStore from "./ObjectStore.js";
import RecordStore from "./RecordStore.js";
import { Key, KeyPath, Record } from "./types.js";
import valueToKey from "./valueToKey.js";

// http://www.w3.org/TR/2015/REC-IndexedDB-20150108/#dfn-index
class Index {
    public deleted = false;
    // Initialized should be used to decide whether to throw an error or abort the versionchange transaction when there is a
    // constraint
    public readonly rawObjectStore: ObjectStore;
    public records: RecordStore;
    private _name: string;
    public readonly keyPath: KeyPath;
    public multiEntry: boolean;
    public unique: boolean;

    constructor(
        rawObjectStore: ObjectStore,
        name: string,
        keyPath: KeyPath,
        multiEntry: boolean,
        unique: boolean,
        public initialized = false
    ) {
        this.rawObjectStore = rawObjectStore;

        this._name = name;
        this.keyPath = keyPath;
        this.multiEntry = multiEntry;
        this.unique = unique;
        this.records = new RecordStore(`IDBFactory.databases['${rawObjectStore.rawDatabase.name}'].objectStores['${rawObjectStore.name}'].indexes['${name}']`);
    }

    public get name() : string {
        return this._name
    }

    public set name(name: string) {
        const records = new RecordStore(`IDBFactory.databases['${this.rawObjectStore.rawDatabase.name}'].objectStores['${this.rawObjectStore.name}'].indexes['${name}']`);
        for(const record of this.records.values()) {
            records.add(record);
        }
        this.records.clear();
        this._name = name;
        this.records = records;
    }

    // http://www.w3.org/TR/2015/REC-IndexedDB-20150108/#dfn-steps-for-retrieving-a-value-from-an-index
    public getKey(key: FDBKeyRange | Key) {
        const record = this.records.get(key);

        return record !== undefined ? record.value : undefined;
    }

    // http://w3c.github.io/IndexedDB/#retrieve-multiple-referenced-values-from-an-index
    public getAllKeys(range: FDBKeyRange, count?: number) {
        if (count === undefined || count === 0) {
            count = Infinity;
        }

        const records = [];
        for (const record of this.records.values(range)) {
            records.push(structuredClone(record.value));
            if (records.length >= count) {
                break;
            }
        }

        return records;
    }

    // http://www.w3.org/TR/2015/REC-IndexedDB-20150108/#index-referenced-value-retrieval-operation
    public getValue(key: FDBKeyRange | Key) {
        const record = this.records.get(key);

        return record !== undefined
            ? this.rawObjectStore.getValue(record.value)
            : undefined;
    }

    // http://w3c.github.io/IndexedDB/#retrieve-multiple-referenced-values-from-an-index
    public getAllValues(range: FDBKeyRange, count?: number) {
        if (count === undefined || count === 0) {
            count = Infinity;
        }

        const records = [];
        for (const record of this.records.values(range)) {
            records.push(this.rawObjectStore.getValue(record.value));
            if (records.length >= count) {
                break;
            }
        }

        return records;
    }

    // http://www.w3.org/TR/2015/REC-IndexedDB-20150108/#dfn-steps-for-storing-a-record-into-an-object-store (step 7)
    public storeRecord(newRecord: Record) {
        let indexKey;
        try {
            indexKey = extractKey(this.keyPath, newRecord.value);
        } catch (err) {
            if (err.name === "DataError") {
                // Invalid key is not an actual error, just means we do not store an entry in this index
                return;
            }

            throw err;
        }

        if (!this.multiEntry || !Array.isArray(indexKey)) {
            try {
                valueToKey(indexKey);
            } catch (e) {
                return;
            }
        } else {
            // remove any elements from index key that are not valid keys and remove any duplicate elements from index
            // key such that only one instance of the duplicate value remains.
            const keep = [];
            for (const part of indexKey) {
                if (keep.indexOf(part) < 0) {
                    try {
                        keep.push(valueToKey(part));
                    } catch (err) {
                        /* Do nothing */
                    }
                }
            }
            indexKey = keep;
        }

        if (!this.multiEntry || !Array.isArray(indexKey)) {
            if (this.unique) {
                const existingRecord = this.records.get(indexKey);
                if (existingRecord) {
                    throw new ConstraintError();
                }
            }
        } else {
            if (this.unique) {
                for (const individualIndexKey of indexKey) {
                    const existingRecord = this.records.get(individualIndexKey);
                    if (existingRecord) {
                        throw new ConstraintError();
                    }
                }
            }
        }

        if (!this.multiEntry || !Array.isArray(indexKey)) {
            this.records.add({
                key: indexKey,
                value: newRecord.key,
            });
        } else {
            for (const individualIndexKey of indexKey) {
                this.records.add({
                    key: individualIndexKey,
                    value: newRecord.key,
                });
            }
        }
    }

    public initialize(transaction: FDBTransaction) {
        if (this.initialized) {
            throw new Error("Index already initialized");
        }

        transaction._execRequestAsync({
            operation: () => {
                try {
                    // Create index based on current value of objectstore
                    for (const record of this.rawObjectStore.records.values()) {
                        this.storeRecord(record);
                    }

                    this.initialized = true;
                } catch (err) {
                    // console.error(err);
                    transaction._abort(err.name);
                }
            },
            source: null,
        });
    }

    public count(range: FDBKeyRange) {
        let count = 0;

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for (const record of this.records.values(range)) {
            count += 1;
        }

        return count;
    }
}

export default Index;
