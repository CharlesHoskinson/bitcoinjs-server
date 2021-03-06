var logger = require('../../logger');
var Step = require('step');
var Storage = require('../../storage').Storage;
var Connection = require('../../connection').Connection;
var util = require('util');
var fs = require('fs');

var tokyo = require('../../../tokyocabinet'); // database
var HDB = tokyo.HDB;
var BDB = tokyo.BDB;

var Block = require('../../schema/block').Block;
var Transaction = require('../../schema/transaction').Transaction;

function serializeBlock(block)
{
  var data = {
    prev_hash: block.prev_hash.toString('binary'),
    merkle_root: block.merkle_root.toString('binary'),
    timestamp: block.timestamp,
    bits: block.bits,
    nonce: block.nonce,
    version: block.version,
    height: block.height,
    size: block.size,
    active: block.active,
    chainWork: block.chainWork.toString('binary'),
    txs: block.txs.map(function (hash) {
      return hash.toString('binary');
    })
  };

  return JSON.stringify(data);
};

function deserializeBlock(data) {
  data = JSON.parse(data);
  data.prev_hash = new Buffer(data.prev_hash, 'binary');
  data.merkle_root = new Buffer(data.merkle_root, 'binary');
  data.chainWork = new Buffer(data.chainWork, 'binary');
  data.txs = data.txs.map(function (hash) {
      return new Buffer(hash, 'binary');
  });
  return new Block(data);
};

function serializeTransaction(tx) {
  return tx.serialize().toString('binary');
};

function deserializeTransaction(data) {
  return new Transaction(Connection.parseTx(new Buffer(data, 'binary')));
};

var tempHeightBuffer = new Buffer(4);
function formatHeightKey(height) {
  height = Math.floor(+height);
  tempHeightBuffer[0] = height >> 24 & 0xff;
  tempHeightBuffer[1] = height >> 16 & 0xff;
  tempHeightBuffer[2] = height >>  8 & 0xff;
  tempHeightBuffer[3] = height       & 0xff;
  return tempHeightBuffer.toString('binary');
};

var TokyoStorage = exports.TokyoStorage = exports.Storage =
function TokyoStorage(uri) {
  var self = this;

  var hBlock;
  var hTransaction;
  var hBlockPrevIndex;
  var bBlockHeightIndex;
  var bBlockTxsIndex;
  var bTxAffectsIndex;

  var prefix = '/tmp/';

  var connected = false;
  this.connect = function (callback) {
    throw new Error("FIXME: Kyoto Cabinet backend implementation unfinished.");

    if (connected) {
      callback(null);
      return;
    }
    connected = true;

    logger.info("Initializing Tokyo Cabinet ("+uri+")");

    Step(
      function createBlockDb() {
        self.hBlock = hBlock = new HDB;
        if (!hBlock.setmutex()) throw new Error(hBlock.errmsg());
        hBlock.openAsync(prefix+'block.tch', HDB.OWRITER | HDB.OCREAT, this);
      },
      function createTransactionDb(err) {
        if (err) throw err;

        self.hTransaction = hTransaction = new HDB;
        if (!hTransaction.setmutex()) throw new Error(hTransaction.errmsg());
        hTransaction.openAsync(prefix+'tx.tch', HDB.OWRITER | HDB.OCREAT, this);
      },
      function createBlockPrevIndexDb(err) {
        if (err) throw err;
        
        self.hBlockPrevIndex = hBlockPrevIndex = new HDB;
        if (!hBlockPrevIndex.setmutex()) throw new Error(hBlockPrevIndex.errmsg());
        hBlockPrevIndex.openAsync(prefix+'bpi.tch', BDB.OWRITER | BDB.OCREAT, this);
      },
      function createBlockHeightIndexDb(err) {
        if (err) throw err;
        
        self.bBlockHeightIndex = bBlockHeightIndex = new BDB;
        if (!bBlockHeightIndex.setmutex()) throw new Error(bBlockHeightIndex.errmsg());
        bBlockHeightIndex.openAsync(prefix+'bhi.tcb', BDB.OWRITER | BDB.OCREAT, this);
      },
      function createBlockTxsIndexDb(err) {
        if (err) throw err;
        
        self.bBlockTxsIndex = bBlockTxsIndex = new BDB;
        if (!bBlockTxsIndex.setmutex()) throw new Error(bBlockTxsIndex.errmsg());
        bBlockTxsIndex.openAsync(prefix+'bti.tcb', BDB.OWRITER | BDB.OCREAT, this);
      },
      function createTxAffectsIndexDb(err) {
        if (err) throw err;
        
        self.bTxAffectsIndex = bTxAffectsIndex = new BDB;
        if (!bTxAffectsIndex.setmutex()) throw new Error(bTxAffectsIndex.errmsg());
        bTxAffectsIndex.openAsync(prefix+'tai.tcb', BDB.OWRITER | BDB.OCREAT, this);
      },
      callback
    );
  };

  var emptyDatabase = this.emptyDatabase =
  function emptyDatabase(callback) {
    Step(
      function () {
        hBlock.vanishAsync(this);
      },
      function (err) {
        if (err) throw err;

        hTransaction.vanishAsync(this);
      },
      function (err) {
        if (err) throw err;

        bBlockHeightIndex.vanishAsync(this);
      },
      callback
    );
  };

  this.dropDatabase = function (callback) {
    fs.unlinkSync(prefix+'block.tch');
    fs.unlinkSync(prefix+'tx.tch');
    fs.unlinkSync(prefix+'bpi.tch');
    fs.unlinkSync(prefix+'bhi.tcb');
    fs.unlinkSync(prefix+'bti.tcb');
    fs.unlinkSync(prefix+'tai.tcb');
    callback(null);
  };

  this.saveBlock = function (block, callback) {
    var hash = block.getHash().toString('binary');
    var data = serializeBlock(block);
    Step(
      function () {
        hBlock.putAsync(hash, data, this);
      },
      function (err) {
        if (err) throw err;

        // TODO: Encode as integer
        var height = formatHeightKey(block.height);
        bBlockHeightIndex.putAsync(height, hash, this);
      },
      function (err) {
        if (err) throw err;

        var prevHash = block.prev_hash.toString('binary');
        hBlockPrevIndex.putAsync(prevHash, hash, this);
      },
      callback
    );
  };

  this.saveTransaction = function (tx, callback) {
    var hash = tx.getHash().toString('binary');
    var data = serializeTransaction(tx);
    hTransaction.putAsync(hash, data, callback);
  };

  this.saveTransactions = function (txs, callback) {
    var txMap = {};
    txs.forEach(function (tx) {
      txMap[tx.getHash().toString('binary')] = serializeTransaction(tx);
    });
    hTransaction.setBulk(txMap, callback);
  };

  var getTransactionByHash = this.getTransactionByHash =
  function getTransactionByHash(hash, callback) {
    if (Buffer.isBuffer(hash)) {
      hash = hash.toString('binary');
    }

    hTransaction.get(hash, function (err, data) {
      callback(null, deserializeTransaction(data));
    });
  };

  var getTransactionsByHashes = this.getTransactionsByHashes =
  function getTransactionsByHashes(hashes, callback) {
    for (var i = 0, l = hashes.length; i < l; i++) {
      if (Buffer.isBuffer(hashes[i])) {
         hashes[i] = hashes[i].toString('binary');
      }
    }

    hTransaction.getBulk(hashes, function (err, txs) {
      if (err) {
        callback(err);
        return;
      }

      var txArray = [];
      hashes.forEach(function (hash) {
        var tx = txs[hash];
        if (tx) {
          txArray.push(deserializeTransaction(tx));
        }
      });

      callback(null, txArray);
    });
  };

  this.getOutputsByHashes = function (hashes, callback) {
    getTransactionsByHashes(hashes, callback);
  };

  this.getBlocksByHeights = function (heights, callback) {
    heights = heights.map(function (height) {
      return formatHeightKey(height);
    });
    Step(
      function () {
        bBlockHeightIndex.getBulk(heights, this);
      },
      function (err, map) {
        if (err) throw err;

        var hashes = [];
        heights.forEach(function (height) {
          var hash = map[height];
          if (hash) {
            hashes.push(hash);
          }
        });
        getBlocksByHashes(hashes, this);
      },
      callback
    );
  };

  var getBlockByHash = this.getBlockByHash =
  function getBlockByHash(hash, callback) {
    if (Buffer.isBuffer(hash)) {
      hash = hash.toString('binary');
    }

    hBlock.get(hash, function getBlockByHashCallback(err, data) {
      if (err) {
        callback(err);
        return;
      }

      if (data) {
        data = deserializeBlock(data);
      }

      callback(null, data);
    });
  };

  var getBlocksByHashes = this.getBlocksByHashes =
  function getBlocksByHashes(hashes, callback) {
    for (var i = 0, l = hashes.length; i < l; i++) {
      if (Buffer.isBuffer(hashes[i])) {
         hashes[i] = hashes[i].toString('binary');
      }
    }

    hBlock.getBulk(hashes, function (err, blocks) {
      if (err) {
        callback(err);
        return;
      }

      var blocksArray = [];
      hashes.forEach(function (hash) {
        var block = blocks[hash];
        if (block) {
          blocksArray.push(deserializeBlock(block));
        }
      });

      callback(null, blocksArray);
    });
  };

  var getBlockByHeight = this.getBlockByHeight =
  function getBlockByHeight(height, callback) {
    height = formatHeightKey(height);
    Step(
      function () {
        bBlockHeightIndex.get(height, this);
      },
      function (err, result) {
        if (err) throw err;

        if (!result) {
          this(null, null);
        } else {
          getBlockByHash(result, this);
        }
      },
      callback
    );
  };

  var getBlockByPrev = this.getBlockByPrev =
  function getBlockByPrev(block, callback) {
    if ("object" == typeof block && block.hash) {
      block = block.hash;
    }

    if (Buffer.isBuffer(block)) {
      block = block.toString('binary');
    }

    hBlockPrevIndex.get(block, function getBlockByPrevCallback(err, data) {
      if (err) {
        callback(err);
        return;
      }

      if (data) {
        getBlockByHash(data, callback);
      } else {
        callback(null, null);
      }
    });
  };

  var getTopBlock = this.getTopBlock =
  function getTopBlock(callback) {
    var cursor = bBlockHeightIndex.cursor();
    Step(
      function () {
        cursor.jumpBack(this);
      },
      function (err) {
        if (err) throw err;

        cursor.get(this);
      },
      function (err, hash, height) {
        if (err) throw err;

        getBlockByHash(hash, this);
      },
      callback
    );
  };

  /**
   * Find the latest matching block from a locator.
   *
   * A locator is basically just a list of hashes. We send it to the database
   * and ask it to get the latest block that is in the list.
   */
  var getBlockByLocator = this.getBlockByLocator =
  function (locator, callback)
  {
    getBlocksByHashes(locator, function (err, blocks) {
      if (err) {
        callback(err);
        return;
      }

      var highest = null;
      blocks.forEach(function (block) {
        if (block.active &&
            ((!highest) || block.height > highest.height)) {
          highest = block;
        }
      });

      callback(null, highest);
    });
  };

  var countConflictingTransactions = this.countConflictingTransactions =
  function countConflictingTransactions(srcOutCondList, callback) {
    // TODO: Enable
    callback(null, 0);
  };

  var getConflictingTransactions = this.getConflictingTransactions =
  function getConflictingTransactions(srcOutCondList, callback) {
    throw new Error('not implemented');
  };

  var knowsBlock = this.knowsBlock =
  function knowsBlock(hash, callback) {
    getBlockByHash(hash, function (err, block) {
      if (err) {
        callback(err);
        return;
      }

      callback(null, !!block);
    });
  };

  var knowsTransaction = this.knowsTransaction =
  function knowsTransction(hash, callback) {
    getTransactionByHash(hash, function (err, tx) {
      if (err) {
        callback(err);
        return;
      }

      callback(null, !!tx);
    });
  };
};

util.inherits(KyotoStorage, Storage);
