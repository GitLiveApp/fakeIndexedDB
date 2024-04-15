import { Memento } from "vscode";
import FDBKeyRange from "../FDBKeyRange.js";
import Database from "./Database.js";
import { ConstraintError, DataError } from "./errors.js";
import extractKey from "./extractKey.js";
import Index from "./Index.js";
import KeyGenerator from "./KeyGenerator.js";
import RecordStore from "./RecordStore.js";
import { Key, KeyPath, Record, RollbackLog } from "./types.js";

interface IndexInfo {
    name: string,
    keyPath: KeyPath,
    multiEntry: boolean;
    unique: boolean;
}


// http://www.w3.org/TR/2015/REC-IndexedDB-20150108/#dfn-object-store
class ObjectStore {
    public deleted = false;
    public readonly rawDatabase: Database;
    public records: RecordStore;
    private _rawIndexes: ReadonlyMap<string, Index> | undefined;
    private _name: string;
    public readonly keyPath: KeyPath | null;
    public readonly autoIncrement: boolean;
    public readonly keyGenerator: KeyGenerator | null;

    constructor(
        rawDatabase: Database,
        name: string,
        keyPath: KeyPath | null,
        autoIncrement: boolean,
    ) {
        this.rawDatabase = rawDatabase;
        this.keyGenerator = autoIncrement === true ? new KeyGenerator() : null;
        this.deleted = false;

        this._name = name;
        this.keyPath = keyPath;
        this.autoIncrement = autoIncrement;
        this.records = new RecordStore(`IDBFactory.databases['${rawDatabase.name}'].objectStores['${name}']`);
    }

    public get name() : string {
        return this._name
    }

    public set name(name: string) {
        const records = new RecordStore(`IDBFactory.databases['${this.rawDatabase.name}'].objectStores['${name}']`);
        for(const record of this.records.values()) {
            records.add(record);
        }
        this.records.clear();
        this._name = name;
        this.records = records;
    }
    
    public get rawIndexes() : ReadonlyMap<string, Index> {
        if(!this._rawIndexes) {
            const entries = this.rawDatabase.memento
                .get<IndexInfo[]>(`IDBFactory.databases['${this.rawDatabase.name}'].objectStores['${this.name}'].indexes`)
                ?.map<[string, Index]>(it => [it.name, new Index(this, it.name, it.keyPath, it.multiEntry,  it.unique, true)])
                || [];
            this._rawIndexes = new Map(entries);
        }
        return this._rawIndexes!
    }

    public set rawIndexes(value: ReadonlyMap<string, Index>) {
        this._rawIndexes = value;
        this.rawDatabase.memento.update(
            `IDBFactory.databases['${this.rawDatabase.name}'].objectStores['${this.name}'].indexes`, 
            Array.from(value.values()).map<IndexInfo>(it => ({ name: it.name, keyPath: it.keyPath, multiEntry: it.multiEntry, unique: it.unique }))
        ).then(undefined, it => console.error(it));   
    }

    // http://www.w3.org/TR/2015/REC-IndexedDB-20150108/#dfn-steps-for-retrieving-a-value-from-an-object-store
    public getKey(key: FDBKeyRange | Key) {
        const record = this.records.get(key);

        return record !== undefined ? structuredClone(record.key) : undefined;
    }

    // http://w3c.github.io/IndexedDB/#retrieve-multiple-keys-from-an-object-store
    public getAllKeys(range: FDBKeyRange, count?: number) {
        if (count === undefined || count === 0) {
            count = Infinity;
        }

        const records = [];
        for (const record of this.records.values(range)) {
            records.push(structuredClone(record.key));
            if (records.length >= count) {
                break;
            }
        }

        return records;
    }

    // http://www.w3.org/TR/2015/REC-IndexedDB-20150108/#dfn-steps-for-retrieving-a-value-from-an-object-store
    public getValue(key: FDBKeyRange | Key) {
        const record = this.records.get(key);

        return record !== undefined ? structuredClone(record.value) : undefined;
    }

    // http://w3c.github.io/IndexedDB/#retrieve-multiple-values-from-an-object-store
    public getAllValues(range: FDBKeyRange, count?: number) {
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

    // http://www.w3.org/TR/2015/REC-IndexedDB-20150108/#dfn-steps-for-storing-a-record-into-an-object-store
    public storeRecord(
        newRecord: Record,
        noOverwrite: boolean,
        rollbackLog?: RollbackLog,
    ) {
        if (this.keyPath !== null) {
            const key = extractKey(this.keyPath, newRecord.value);
            if (key !== undefined) {
                newRecord.key = key;
            }
        }

        if (this.keyGenerator !== null && newRecord.key === undefined) {
            if (rollbackLog) {
                const keyGeneratorBefore = this.keyGenerator.num;
                rollbackLog.push(() => {
                    if (this.keyGenerator) {
                        this.keyGenerator.num = keyGeneratorBefore;
                    }
                });
            }

            newRecord.key = this.keyGenerator.next();

            // Set in value if keyPath defiend but led to no key
            // http://www.w3.org/TR/2015/REC-IndexedDB-20150108/#dfn-steps-to-assign-a-key-to-a-value-using-a-key-path
            if (this.keyPath !== null) {
                if (Array.isArray(this.keyPath)) {
                    throw new Error(
                        "Cannot have an array key path in an object store with a key generator",
                    );
                }
                let remainingKeyPath = this.keyPath;
                let object = newRecord.value;
                let identifier;

                let i = 0; // Just to run the loop at least once
                while (i >= 0) {
                    if (typeof object !== "object") {
                        throw new DataError();
                    }

                    i = remainingKeyPath.indexOf(".");
                    if (i >= 0) {
                        identifier = remainingKeyPath.slice(0, i);
                        remainingKeyPath = remainingKeyPath.slice(i + 1);

                        if (!Object.hasOwn(object, identifier)) {
                            object[identifier] = {};
                        }

                        object = object[identifier];
                    }
                }

                identifier = remainingKeyPath;

                object[identifier] = newRecord.key;
            }
        } else if (
            this.keyGenerator !== null &&
            typeof newRecord.key === "number"
        ) {
            this.keyGenerator.setIfLarger(newRecord.key);
        }

        const existingRecord = noOverwrite || rollbackLog ? this.records.get(newRecord.key) : undefined;
        if (existingRecord) {
            if (noOverwrite) {
                throw new ConstraintError();
            }
            if (rollbackLog) {
                rollbackLog.push(() => {
                    this.storeRecord(existingRecord, false);
                });
            }
        }

        this.records.add(newRecord);

        // Update indexes
        for (const rawIndex of this.rawIndexes.values()) {
            if (rawIndex.initialized) {
                rawIndex.storeRecord(newRecord);
            }
        }

        return newRecord.key;
    }

    // http://www.w3.org/TR/2015/REC-IndexedDB-20150108/#dfn-steps-for-deleting-records-from-an-object-store
    public deleteRecord(key: Key, rollbackLog?: RollbackLog) {
        const deletedRecords = this.records.delete(key);

        if (rollbackLog) {
            for (const record of deletedRecords) {
                rollbackLog.push(() => {
                    this.storeRecord(record, true);
                });
            }
        }

        for (const rawIndex of this.rawIndexes.values()) {
            rawIndex.records.deleteByValue(key);
        }
    }

    // http://www.w3.org/TR/2015/REC-IndexedDB-20150108/#dfn-steps-for-clearing-an-object-store
    public clear(rollbackLog: RollbackLog) {
        const deletedRecords = this.records.clear();

        if (rollbackLog) {
            for (const record of deletedRecords) {
                rollbackLog.push(() => {
                    this.storeRecord(record, true);
                });
            }
        }

        for (const rawIndex of this.rawIndexes.values()) {
            rawIndex.records.clear();
        }
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

export default ObjectStore;
