var db = require('../../config/initializers/sequelize.js')
var utils = require("../../lib/utils")
var RippleAddress = require('./ripple_address.js')
var ExternalAccount = require('./external_account.js')
var RippleWallet = require('ripple-wallet').Ripple.Wallet;
var crypto = require("crypto")
var sjcl = require('sjcl')
var async = require('async');
var bn = require("bignumber.js");
var Sequelize = require('sequelize');
var pgHstore  = require('pg-hstore');

var User = db.define('user', {
  id: { 
		type: Sequelize.INTEGER,
		primaryKey: true,
		autoIncrement: true,
		notNull: true,
		unique: true,
	},
  federation_tag: Sequelize.STRING,
  admin: Sequelize.BOOLEAN,
  federation_name: Sequelize.STRING,
  kyc_id: Sequelize.INTEGER,
  name: { type: Sequelize.STRING, unique: true },
  salt: Sequelize.STRING,
  password_hash: Sequelize.STRING,
  external_id: Sequelize.STRING,
  data: { type: Sequelize.HSTORE, defaultValue: '"default"=>"value"' }
}, {
  hooks: {
    afterCreate: function(user, fn) {
      if (!(user.name == 'admin')) {
        RippleAddress.createHosted(user, function(err, address) {
          fn(err, user);
        });
      } else {
        fn(null, user);
      }
    }
  },
  instanceMethods: {
    hostedAddress: function(fn) {
      var user = this;
      RippleAddress.find({ where: { user_id: user.id, tag: user.id, type: 'hosted' }})
        .complete(fn);
    },
    createExternalAccount: function(name, fn) {
      ExternalAccount.create({ name: name, user_id: this.id }).complete(fn);
    },
    defaultExternalAccount: function(fn) {
      ExternalAccount.find({ where: {
        user_id: this.id,
        name: 'Default' 
      }}).complete(fn);
    },
    balances: function(fn) {
      var user = this;
      var externalBalances = [];
      var rippleBalances = [];
      var aggregateBalances = [];
      async.parallel([
        function (complete) {
          user.externalBalances(function(err, balances) {
            externalBalances = balances;
            complete();
          });
        },
        function (complete) {
          user.rippleBalances(function(err, balances){
            rippleBalances = balances; 
            complete();
          });
        }
      ], function(err){
        var balances = {}
        externalBalances.concat(rippleBalances).forEach(function(balance){
          if (!balances[balance.currency]) {
            balances[balance.currency] = (new bn(0));
          }
          var diff = balances[balance.currency].plus(new bn(balance.amount));
          balances[balance.currency] = diff;
        });

        var result = [];
        for(var index in balances) { 
           if (balances.hasOwnProperty(index)) {
              result.push({ currency: index, amount: balances[index].toString() });
           };
        };

        fn(err, result);
      });
    },
    rippleBalances: function(fn){
      var rippleDeposits, rippleWithdrawals;
      var user = this;
      async.parallel([
        function(complete) {
          // ripple withdrawals
          var query = 'select SUM(from_amount) as amount, from_currency as currency from ripple_transactions ';
          query += 'join ripple_addresses on ripple_transactions.ripple_address_id = ripple_addresses.id ';
          query += "where user_id = "+user.id+" and issuance = 'true' group by currency;";
          db.query(query).complete(function(err, withdrawals){
            rippleWithdrawals = withdrawals;
            complete();
          });
        },
        function(complete) {
          // ripple deposits
          var query = 'select SUM(to_amount) as amount, from_currency as currency from ripple_transactions ';
          query += 'join ripple_addresses on ripple_transactions.ripple_address_id = ripple_addresses.id ';
          query += "where user_id = "+user.id+" and issuance = 'false' group by currency;"
          db.query(query).complete(function(err, deposits){
            rippleDeposits = deposits;
            complete();
          });
        }
      ], function(err) {
        var rippleBalances ={};
        rippleDeposits.forEach(function(deposit){
          if (!rippleBalances[deposit.currency]) {
            rippleBalances[deposit.currency] = (new bn(0));
          }
          var diff = rippleBalances[deposit.currency].plus(new bn(deposit.amount));
          rippleBalances[deposit.currency] = diff;
        });

        rippleWithdrawals.forEach(function(withdrawal){
          if (!rippleBalances[withdrawal.currency]) {
            rippleBalances[withdrawal.currency] = (new bn(0));
          }
          var diff = rippleBalances[withdrawal.currency].minus(new bn(withdrawal.amount));
          rippleBalances[withdrawal.currency] = diff;
        });


        var balances = [];
        for(var index in rippleBalances) { 
           if (rippleBalances.hasOwnProperty(index)) {
              balances.push({ currency: index, amount: rippleBalances[index].toString() });
           }
        }

        fn(err, balances);
      });
    },
    externalBalances: function(fn){
      var externalDepsosits, externalWithdrawals;
      var user = this;
      async.parallel([
        function(complete) {
          var query = 'select SUM(cash_amount) as amount, currency from external_transactions ';
          query += 'join external_accounts on external_transactions.external_account_id = external_accounts.id ';
          query += 'where user_id = '+user.id+' and deposit = false group by currency;'
          db.query(query).complete(function(err, withdrawals){
            externalWithdrawals = withdrawals;
            complete();
          });
        },
        function(complete) {
          var query = 'select SUM(cash_amount) as amount, currency from external_transactions ';
          query += 'join external_accounts on external_transactions.external_account_id = external_accounts.id ';
          query += 'where user_id = '+user.id+' and deposit = true group by currency;'
          db.query(query).complete(function(err, deposits){
            externalDeposits = deposits;
            complete();
          });
        }
      ], function(err) {
        var externalBalances ={};
        externalDeposits.forEach(function(deposit){
          if (!externalBalances[deposit.currency]) {
            externalBalances[deposit.currency] = (new bn(0));
          }
          var diff = externalBalances[deposit.currency].plus(new bn(deposit.amount));
          externalBalances[deposit.currency] = diff;
        });

        externalWithdrawals.forEach(function(withdrawal){
          if (!externalBalances[withdrawal.currency]) {
            externalBalances[withdrawal.currency] = (new bn(0));
          }
          var diff = externalBalances[withdrawal.currency].minus(new bn(withdrawal.amount));
          externalBalances[withdrawal.currency] = diff;
        });


        var balances = [];
        for(var index in externalBalances) { 
           if (externalBalances.hasOwnProperty(index)) {
              balances.push({ currency: index, amount: externalBalances[index].toString() });
           }
        }

        fn(err, balances);
      });
    },
    externalAccounts: function(fn){
      var query = 'select * from external_accounts where user_id = '+this.id;
      db.query(query).complete(fn);
    },
    externalTransactions: function(fn){
      this.externalAccounts(function(err, accounts) {
        externalAccountIds = accounts.map(function(account){
          return account.id;
        });
        ExternalTransaction.findAll({ where: { external_account_id: externalAccountIds }, limit: 10, order: '"createdAt" DESC' }).complete(function(err, transactions) {
          fn(err, transactions);

        });
      });
    },
    rippleAddresses: function(fn){
      RippleAddress.findAll({ where: { user_id: this.id }}).complete(fn);
    },
    rippleTransactions: function(fn){
      this.rippleAddresses(function(err, addresses) {
        rippleAddressIds = addresses.map(function(address){
          return address.id;
        });
        if (rippleAddressIds) {
          RippleTransaction.findAll({ order: '"createdAt" DESC', limit: 10, where: { ripple_address_id: rippleAddressIds }}).complete(function(err, transactions) {
            fn(err, transactions);
          });
        } else {
          fn(err, []);
        }
      });
    },
    updateUser: function(opts, fn) {

      // if there's already an hstore data entry, we should extend it instead of replacing
      if (opts.data && this.data) {
        
        var callback = function(result) {

          // copy over the data into the existing hstore data
          for (var key in opts.data) {
            result[key] = opts.data[key];
          }

          // execute the update with the extended payload
          opts.data = result;
          this.updateAttributes(opts).success(fn);
        };

        pgHstore.parse(this.data, callback.bind(this));
      } else {
        this.updateAttributes(opts).success(fn);
      }
    }
  },
  classMethods: {
    createAdmin: function(callback) {
      User.find({ where: { admin: true }}).complete(function(err, admins){
        if (admins && (admins.length > 0)) {
          callback('admin already exists', null)
        } else {
          var password = crypto.randomBytes(32).toString('hex')
          User.createWithSalt({
            name: 'admin',
            password: password,
            admin: true
          }, function(err, admin) {
            if (err) { callback(err, null); return } 
            hotWallet = RippleWallet.generate()
            coldWallet = RippleWallet.generate()
            admin.password = password 

            RippleAddress.create({
              managed: true,
              user_id: admin.id,
              type: 'hot',
              address: hotWallet.address,
              secret: hotWallet.secret
            }).complete(function(err, hotAddress) {
              if(err) { 
                callback(null, { admin: admin, wallets: { hot: hotWallet, cold: coldWallet }})
              }
              RippleAddress.create({
                managed: true,
                user_id: admin.id,
                type: 'cold',
                address: coldWallet.address,
                secret: coldWallet.secret
              }).complete(function(err, coldAddress) {
                if (err) { 
                  callback(err, { admin: admin, wallets: { hot: hotWallet, cold: coldWallet }})
                }
                callback(null, { admin: admin, password: password, addresses: [hotAddress, coldAddress], wallets: { hot: hotWallet, cold: coldWallet }})
              })
            })
          })
        }
      })
    },
    createWithSalt: function(opts, fn) {
      var salt = utils.generateSalt();
      var passwordHash = utils.saltPassword(opts.password, salt)
      var admin = opts.admin || false

      var user = User.create({
        name: opts.name,
        admin: admin,
        salt: salt,
        password_hash: passwordHash,
      }).complete(fn);
    }
  }
});

module.exports = User;
