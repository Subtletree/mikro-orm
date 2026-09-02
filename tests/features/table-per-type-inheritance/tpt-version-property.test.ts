import { MikroORM, OptionalProps, OptimisticLockError } from '@mikro-orm/sqlite';
import { Entity, PrimaryKey, Property, ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { mockLogger } from '../../bootstrap.js';

// versioned TPT hierarchy - the version column exists only on the root table
@Entity({ inheritance: 'tpt' })
abstract class Animal {
  [OptionalProps]?: 'version';

  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;

  @Property({ version: true })
  version!: number;
}

@Entity()
class Dog extends Animal {
  @Property()
  breed!: string;
}

@Entity()
class GermanShepherd extends Dog {
  @Property()
  pedigree!: string;
}

// non-TPT versioned entity, to pin the non-inheritance branch of `ownsVersionProperty()`
@Entity()
class Shelter {
  [OptionalProps]?: 'version';

  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;

  @Property({ version: true })
  version!: number;
}

// the version column need not live on the root - here it belongs to the middle table
@Entity({ inheritance: 'tpt' })
abstract class Bird {
  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;
}

@Entity()
class Parrot extends Bird {
  [OptionalProps]?: 'version';

  @Property({ version: true })
  version!: number;

  @Property()
  ring!: string;
}

@Entity()
class Macaw extends Parrot {
  @Property()
  colour!: string;
}

// a Date version exercises the timestamp branch of the version bump
@Entity({ inheritance: 'tpt' })
abstract class Fish {
  [OptionalProps]?: 'version';

  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;

  @Property({ version: true })
  version!: Date;
}

@Entity()
class Goldfish extends Fish {
  @Property()
  tankSize!: string;
}

// identical shape without a version property, as a control
@Entity({ inheritance: 'tpt' })
abstract class Reptile {
  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;
}

@Entity()
class Lizard extends Reptile {
  @Property()
  habitat!: string;
}

describe('TPT inheritance with a version property', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init({
      metadataProvider: ReflectMetadataProvider,
      dbName: ':memory:',
      entities: [Animal, Dog, GermanShepherd, Shelter, Bird, Fish, Goldfish, Parrot, Macaw, Reptile, Lizard],
    });
    await orm.schema.create();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await orm.schema.clear();
    orm.em.clear();
  });

  const updates = (mock: ReturnType<typeof mockLogger>) => {
    return mock.mock.calls.map(c => c[0] as string).filter(sql => sql.includes('update '));
  };

  // the bump lives in the SET clause and the optimistic lock predicate in the WHERE clause,
  // so assert on both rather than merely on the column appearing somewhere in the statement
  const expectVersionBumpAndLock = (sql: string) => {
    expect(sql).toMatch(/set .*`version`/);
    expect(sql).toMatch(/where .*`version`/);
  };

  describe('metadata', () => {
    test('only the table declaring the version column owns it', () => {
      const animal = orm.getMetadata().get(Animal);
      const dog = orm.getMetadata().get(Dog);
      const shepherd = orm.getMetadata().get(GermanShepherd);

      // the whole hierarchy resolves the version property, so `em.lock()` keeps working
      expect(animal.versionProperty).toBe('version');
      expect(dog.versionProperty).toBe('version');
      expect(shepherd.versionProperty).toBe('version');

      // ...but the column lives only on the root table
      expect(animal.ownsVersionProperty()).toBe(true);
      expect(dog.ownsVersionProperty()).toBe(false);
      expect(shepherd.ownsVersionProperty()).toBe(false);
    });

    test('an unversioned hierarchy owns no version property', () => {
      expect(orm.getMetadata().get(Reptile).ownsVersionProperty()).toBe(false);
      expect(orm.getMetadata().get(Lizard).ownsVersionProperty()).toBe(false);
    });

    test('a non-inherited entity owns its version property', () => {
      expect(orm.getMetadata().get(Shelter).ownsVersionProperty()).toBe(true);
    });

    test('the owning table is the declaring one, not necessarily the root', () => {
      expect(orm.getMetadata().get(Bird).ownsVersionProperty()).toBe(false);
      expect(orm.getMetadata().get(Parrot).ownsVersionProperty()).toBe(true);
      expect(orm.getMetadata().get(Macaw).ownsVersionProperty()).toBe(false);
    });
  });

  describe('updates', () => {
    test('a child-owned column bumps the version on the root table only', async () => {
      const dog = orm.em.create(Dog, { name: 'Rex', breed: 'poodle' });
      await orm.em.flush();
      orm.em.clear();

      const mock = mockLogger(orm, ['query']);
      const found = await orm.em.findOneOrFail(Dog, dog.id);
      found.breed = 'labrador';
      await orm.em.flush();

      const sql = updates(mock);
      expect(sql).toHaveLength(2);
      const [root, child] = sql;

      // the root table carries the version bump and the optimistic lock predicate
      expect(root).toMatch('update `animal`');
      expectVersionBumpAndLock(root);

      // the child table has no version column, so it must carry neither
      expect(child).toMatch('update `dog`');
      expect(child).not.toMatch('`version`');

      expect(found.version).toBe(2);
    });

    test('a root-owned column bumps the version on the root table only', async () => {
      const dog = orm.em.create(Dog, { name: 'Rex', breed: 'poodle' });
      await orm.em.flush();
      orm.em.clear();

      const mock = mockLogger(orm, ['query']);
      const found = await orm.em.findOneOrFail(Dog, dog.id);
      found.name = 'Rexy';
      await orm.em.flush();

      const sql = updates(mock);
      expect(sql).toHaveLength(1);
      expect(sql[0]).toMatch('update `animal`');
      expectVersionBumpAndLock(sql[0]);

      expect(found.version).toBe(2);
    });

    test('columns on both tables bump the version once', async () => {
      const dog = orm.em.create(Dog, { name: 'Rex', breed: 'poodle' });
      await orm.em.flush();
      orm.em.clear();

      const mock = mockLogger(orm, ['query']);
      const found = await orm.em.findOneOrFail(Dog, dog.id);
      found.name = 'Rexy';
      found.breed = 'labrador';
      await orm.em.flush();

      const sql = updates(mock);
      expect(sql).toHaveLength(2);
      const [root, child] = sql;
      expect(root).toMatch('update `animal`');
      expectVersionBumpAndLock(root);
      expect(child).toMatch('update `dog`');
      expect(child).not.toMatch('`version`');

      expect(found.version).toBe(2);
    });

    test('a grandchild-owned column bumps the version on the root table only', async () => {
      const dog = orm.em.create(GermanShepherd, { name: 'Rex', breed: 'poodle', pedigree: 'show' });
      await orm.em.flush();
      orm.em.clear();

      const mock = mockLogger(orm, ['query']);
      const found = await orm.em.findOneOrFail(GermanShepherd, dog.id);
      found.pedigree = 'champion';
      await orm.em.flush();

      const sql = updates(mock);
      expect(sql.filter(s => s.includes('`version`'))).toEqual([expect.stringContaining('update `animal`')]);
      expect(sql.find(s => s.includes('update `german_shepherd`'))).not.toMatch('`version`');

      expect(found.version).toBe(2);
    });

    test('a batched update bumps the version on the root table only', async () => {
      orm.em.create(Dog, { name: 'Rex', breed: 'poodle' });
      orm.em.create(Dog, { name: 'Fido', breed: 'poodle' });
      await orm.em.flush();
      orm.em.clear();

      const mock = mockLogger(orm, ['query']);
      const all = await orm.em.find(Dog, {});
      all.forEach(dog => (dog.breed = 'labrador'));
      await orm.em.flush();

      const sql = updates(mock);
      expect(sql.filter(s => s.includes('`version`'))).toEqual([expect.stringContaining('update `animal`')]);
      expect(sql.find(s => s.includes('update `dog`'))).not.toMatch('`version`');

      expect(all.map(dog => dog.version)).toEqual([2, 2]);
    });

    test('an unversioned hierarchy produces no version handling', async () => {
      const dog = orm.em.create(Lizard, { name: 'Iggy', habitat: 'desert' });
      await orm.em.flush();
      orm.em.clear();

      const mock = mockLogger(orm, ['query']);
      const found = await orm.em.findOneOrFail(Lizard, dog.id);
      found.habitat = 'rainforest';
      await orm.em.flush();

      const sql = updates(mock);
      expect(sql).toHaveLength(1);
      expect(sql[0]).toMatch('update `lizard`');
      expect(sql[0]).not.toMatch('`version`');

      orm.em.clear();
      const reloaded = await orm.em.findOneOrFail(Lizard, dog.id);
      expect(reloaded.habitat).toBe('rainforest');
    });
  });

  describe('version declared below the root', () => {
    test('a leaf-owned column bumps the version on the declaring table', async () => {
      const bird = orm.em.create(Macaw, { name: 'Polly', ring: 'A1', colour: 'blue' });
      await orm.em.flush();
      orm.em.clear();

      const mock = mockLogger(orm, ['query']);
      const found = await orm.em.findOneOrFail(Macaw, bird.id);
      found.colour = 'green';
      await orm.em.flush();

      const sql = updates(mock);
      const versioned = sql.filter(s => s.includes('`version`'));
      expect(versioned).toHaveLength(1);
      expect(versioned[0]).toMatch('update `parrot`');
      expectVersionBumpAndLock(versioned[0]);

      // neither the table above nor the table below the declaring one may carry it
      expect(sql.find(s => s.includes('update `macaw`'))).not.toMatch('`version`');
      expect(found.version).toBe(2);
    });

    test('a batched leaf-owned update bumps the version on the declaring table', async () => {
      orm.em.create(Macaw, { name: 'Polly', ring: 'A1', colour: 'blue' });
      orm.em.create(Macaw, { name: 'Hector', ring: 'A2', colour: 'red' });
      await orm.em.flush();
      orm.em.clear();

      const mock = mockLogger(orm, ['query']);
      const all = await orm.em.find(Macaw, {});
      all.forEach(bird => (bird.colour = 'green'));
      await orm.em.flush();

      const versioned = updates(mock).filter(s => s.includes('`version`'));
      expect(versioned).toHaveLength(1);
      expect(versioned[0]).toMatch('update `parrot`');
      expect(all.map(bird => bird.version)).toEqual([2, 2]);
    });

    test('a root-owned column bumps the version on the declaring table', async () => {
      const bird = orm.em.create(Macaw, { name: 'Polly', ring: 'A1', colour: 'blue' });
      await orm.em.flush();
      orm.em.clear();

      const mock = mockLogger(orm, ['query']);
      const found = await orm.em.findOneOrFail(Macaw, bird.id);
      found.name = 'Hector';
      await orm.em.flush();

      // without the version scoped to its declaring table this emits only the `bird` update,
      // silently skipping both the bump and the lock predicate
      const versioned = updates(mock).filter(s => s.includes('`version`'));
      expect(versioned).toHaveLength(1);
      expect(versioned[0]).toMatch('update `parrot`');
      expectVersionBumpAndLock(versioned[0]);

      orm.em.clear();
      const reloaded = await orm.em.findOneOrFail(Macaw, bird.id);
      expect(reloaded.name).toBe('Hector');
      expect(reloaded.version).toBe(2);
    });

    test('rejects a stale version when the version is not on the root', async () => {
      const bird = orm.em.create(Macaw, { name: 'Polly', ring: 'A1', colour: 'blue' });
      await orm.em.flush();
      const id = bird.id;
      orm.em.clear();

      const em1 = orm.em.fork();
      const em2 = orm.em.fork();
      const first = await em1.findOneOrFail(Macaw, id);
      const second = await em2.findOneOrFail(Macaw, id);

      first.colour = 'green';
      await em1.flush();

      second.colour = 'yellow';
      await expect(em2.flush()).rejects.toThrow(OptimisticLockError);
    });
  });

  describe('date version property', () => {
    test('a child-owned column bumps the date version on the root table only', async () => {
      const fish = orm.em.create(Goldfish, { name: 'Bubbles', tankSize: 'small' });
      await orm.em.flush();
      orm.em.clear();

      const mock = mockLogger(orm, ['query']);
      const found = await orm.em.findOneOrFail(Goldfish, fish.id);
      found.tankSize = 'large';
      await orm.em.flush();

      const sql = updates(mock);
      expect(sql).toHaveLength(2);
      expect(sql[0]).toMatch('update `fish`');
      expectVersionBumpAndLock(sql[0]);
      expect(sql[1]).toMatch('update `goldfish`');
      expect(sql[1]).not.toMatch('`version`');

      expect(found.version).toBeInstanceOf(Date);
    });
  });

  describe('optimistic locking', () => {
    test('rejects a stale version when a child-owned column changed', async () => {
      const dog = orm.em.create(Dog, { name: 'Rex', breed: 'poodle' });
      await orm.em.flush();
      const id = dog.id;
      orm.em.clear();

      const em1 = orm.em.fork();
      const em2 = orm.em.fork();
      const first = await em1.findOneOrFail(Dog, id);
      const second = await em2.findOneOrFail(Dog, id);

      first.breed = 'labrador';
      await em1.flush();

      second.breed = 'beagle';
      await expect(em2.flush()).rejects.toThrow(OptimisticLockError);
    });

    test('rejects a stale version when a root-owned column changed', async () => {
      const dog = orm.em.create(Dog, { name: 'Rex', breed: 'poodle' });
      await orm.em.flush();
      const id = dog.id;
      orm.em.clear();

      const em1 = orm.em.fork();
      const em2 = orm.em.fork();
      const first = await em1.findOneOrFail(Dog, id);
      const second = await em2.findOneOrFail(Dog, id);

      first.name = 'Rexy';
      await em1.flush();

      second.name = 'Ruff';
      await expect(em2.flush()).rejects.toThrow(OptimisticLockError);
    });

    test('rejects a stale version in a batched update', async () => {
      orm.em.create(Dog, { name: 'Rex', breed: 'poodle' });
      orm.em.create(Dog, { name: 'Fido', breed: 'poodle' });
      await orm.em.flush();
      orm.em.clear();

      const em1 = orm.em.fork();
      const em2 = orm.em.fork();
      const first = await em1.find(Dog, {});
      const second = await em2.find(Dog, {});

      first.forEach(dog => (dog.breed = 'labrador'));
      await em1.flush();

      second.forEach(dog => (dog.breed = 'beagle'));
      await expect(em2.flush()).rejects.toThrow(OptimisticLockError);
    });

    test('em.nativeUpdate with an empty payload stays a no-op', async () => {
      const dog = orm.em.create(Dog, { name: 'Rex', breed: 'poodle' });
      await orm.em.flush();
      orm.em.clear();

      const mock = mockLogger(orm, ['query']);
      const affected = await orm.em.nativeUpdate(Animal, { id: dog.id }, {});

      expect(affected).toBe(0);
      expect(updates(mock)).toHaveLength(0);

      const reloaded = await orm.em.fork().findOneOrFail(Dog, dog.id);
      expect(reloaded.version).toBe(1);
    });

    test('successive updates keep incrementing the version', async () => {
      const dog = orm.em.create(Dog, { name: 'Rex', breed: 'poodle' });
      await orm.em.flush();
      expect(dog.version).toBe(1);

      dog.breed = 'beagle';
      await orm.em.flush();
      expect(dog.version).toBe(2);

      dog.name = 'Rexy';
      await orm.em.flush();
      expect(dog.version).toBe(3);

      dog.breed = 'collie';
      dog.name = 'Rover';
      await orm.em.flush();
      expect(dog.version).toBe(4);

      orm.em.clear();
      const reloaded = await orm.em.findOneOrFail(Dog, dog.id);
      expect(reloaded.version).toBe(4);
      expect(reloaded.breed).toBe('collie');
      expect(reloaded.name).toBe('Rover');
    });
  });
});
