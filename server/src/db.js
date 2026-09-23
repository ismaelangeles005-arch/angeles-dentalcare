const { Pool } = require("pg");

const { poolOptions } = require("./config/deployment");
const pool = new Pool(poolOptions());

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = {
  query,
  pool
};
