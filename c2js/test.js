const createModule = require('./index.js');

let myclib;
let Module;

const myclibRuntime = createModule().then((module) => {
console.log('111111',module);

  const get_persons = module.cwrap('get_persons', 'number', []);
  const a = get_persons()
console.log('2222',get_persons);
console.log('2222',a);

});

console.log(22222,myclibRuntime)