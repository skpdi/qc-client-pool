/**
 * Created by uzysjung on 2016. 3. 16..
 */
'use strict';

const qcClient = require('di-qc-client');
const Pool = require('generic-pool').Pool;
const co = require('co');
const _  = require('underscore');
const internals = {};

exports = module.exports = internals.qcPool = function(option,url,id,pass) {

    var property = {
        name     : 'QueryCache',
        create   : function(callback) {
            co( function*(){
                try {
                    var qc = new qcClient();
                    var connected =  yield qc.open(url, id, pass);

                } catch(e) {
                    callback(e);
                }
                if(connected) {
                    callback(null,qc);
                } else {
                    callback(new Error("qc is not connected"));
                }
            });
        },
        destroy  : function(connection) {
            co(function*(){
                // console.log("QC Pool destroy called");
                yield connection.close();
            }).catch(function(e){
                console.error("QC Pool destroy error occured :",e.stack);
            });
        },
        validate : function(connection) {

            if(connection.connectionError) {
                console.log('error remove on validate',connection.connectionError);
                return false;
            }
            return true;
        },
        min: 2,
        max: 10,
        idleTimeoutMillis: 30000,
        queryTimeout : 5000 //5 sec
    };
    property =_.extend(property,option);
    this.pool = new Pool(property);
};

internals.qcPool.prototype.acquire = function() {
    const self = this;
    return new Promise(function(resolve,reject){

        self.pool.acquire(function(err,connection){
            if(err) reject(err);
            resolve(connection);
        });
    });
};

//terminate all the resources in the pool
internals.qcPool.prototype.drain = function() {
    this.pool.destroyAllNow();
};

internals.qcPool.prototype.getPoolSize = function(){
    return this.pool.getPoolSize();
};

internals.qcPool.prototype.getName = function(){
    return this.pool.getName();
};
internals.qcPool.prototype.getAvailableConnectionsCount = function() {
    return this.pool.availableObjectsCount();
};

internals.qcPool.prototype.getWaitingClientsCount = function() {
    return this.pool.waitingClientsCount();
};

internals.qcPool.prototype.getMaxPoolSize= function() {
    return this.pool.getMaxPoolSize();
};

internals.qcPool.prototype.query = function(client,sql,option) {
    var self = this;
    let fn = co(function*(){
        let resultSet,stmt, err;
        let results = [];
        let cbErr;
        try {
            cbErr = function(conn_error) {
              throw conn_error;  
            };
            client.connection.on('error',cbErr);
            stmt = client.createStatement();
            let hasResultSet = yield stmt.execute(sql);
            if (!hasResultSet) {
                throw new Error("query affected " + stmt.updateRowCount + " rows.");
            }

            resultSet = yield stmt.getResultSet();
            if (resultSet == null) {
                throw new Error("query has no result set. (BUG?)");
            }

            let rows = 0;
            for(;;) {
                const nextRowAvailable = yield resultSet.next();
                if (nextRowAvailable) {
                    rows++;
                    if(option && option.rowResultType == "Dictionary")
                        results.push(resultSet.getRowDict());
                    else
                        results.push(resultSet.getRowArray());
                }
                else {
                    break;
                }
            }
        } catch(e) {
            err = e;
        } finally {
            if (resultSet) {
                yield resultSet.close();
            }
            if (stmt) {
                yield stmt.close();
            }
            if(cbErr && client.connection)
                client.connection.removeListener('error',cbErr);

            if(err) throw err;
        }
        return results;
    });

    function timeout(interval) {
        return new Promise(function (resolve, reject) {
            setTimeout(function(){
                reject(new Error('timeout: exceed ' + interval + 'ms'));
            }, interval || 0);
        })
    };

    let queryTimeout = self.pool._factory.queryTimeout;
    if(option && option.queryTimeout) {
        queryTimeout = option.queryTimeout;
    }

    return co( function*() {

        let results,err;
        try {
            results = yield Promise.race([timeout(queryTimeout),fn]);
        } catch(e){
            client.connectionError = e;
            err = e ;
            console.error('qcPool Query Error',e.stack);
        } finally  {
            self.pool.release(client);
            if(err) throw err;
        }
        return results;

    });
};

internals.qcPool.prototype.queryUpsert = function(client,sql) {
    var self = this;
    let fn = co(function*(){
        let result,stmt,err,cbErr;
        try {
            cbErr = function(conn_error) {
              throw conn_error;  
            };
            client.connection.on('error',cbErr);
            stmt = client.createStatement();
            let hasResultSet = yield stmt.execute(sql);
            result = yield stmt.setCommit();
            
        } catch(e){
            err = e ;
        } finally {
            if(stmt) {
                yield stmt.close();
            }
            if(cbErr && client.connection)
                client.connection.removeListener('error',cbErr);
            if(err) throw err;
        }
        return result;
    });
    function timeout(interval) {
        return new Promise(function (resolve, reject) {
            setTimeout(function(){
                reject(new Error('timeout: exceed ' + interval + 'ms'));
            }, interval || 0);
        })
    };
    return co(function*(){
        let result,error;
        try {
            result = yield Promise.race([timeout(self.pool._factory.queryTimeout),fn])
        } catch (e){
            client.connectionError = e;
            console.error('qcPool Query Error :',e.stack);
            error = e;
        } finally  {
            self.pool.release(client);
            if(error) throw error;
        }
        return result;
    });
};

