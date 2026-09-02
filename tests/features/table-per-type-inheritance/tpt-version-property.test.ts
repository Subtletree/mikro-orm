import { MikroORM, OptionalProps } from '@mikro-orm/sqlite';
import { Entity, PrimaryKey, Property, ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';

// TPT hierarchy with the version property on the root
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

// identical shape without a version property, as a control
@Entity({ inheritance: 'tpt' })
abstract class Fish {
  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;
}

@Entity()
class Salmon extends Fish {
  @Property()
  river!: string;
}

// hierarchy whose version property is declared below the root
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
  wingspan!: number;
}

describe('TPT inheritance with a version property', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init({
      metadataProvider: ReflectMetadataProvider,
      dbName: ':memory:',
      entities: [Animal, Dog, Fish, Salmon, Bird, Parrot],
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

  // CONTROL - passes. The version column is on the root table, which is the table being updated.
  test('updating a root-owned column bumps the version', async () => {
    const dog = orm.em.create(Dog, { name: 'Rex', breed: 'poodle' });
    await orm.em.flush();
    orm.em.clear();

    const found = await orm.em.findOneOrFail(Dog, dog.id);
    found.name = 'Rexy';
    await orm.em.flush();
    orm.em.clear();

    const reloaded = await orm.em.findOneOrFail(Dog, dog.id);
    expect(reloaded.name).toBe('Rexy');
    expect(reloaded.version).toBe(2);
  });

  // CONTROL - passes. No version property, so nothing is applied to the child table.
  test('updating a child-owned column works without a version property', async () => {
    const salmon = orm.em.create(Salmon, { name: 'Sammy', river: 'Tay' });
    await orm.em.flush();
    orm.em.clear();

    const found = await orm.em.findOneOrFail(Salmon, salmon.id);
    found.river = 'Spey';
    await orm.em.flush();
    orm.em.clear();

    const reloaded = await orm.em.findOneOrFail(Salmon, salmon.id);
    expect(reloaded.river).toBe('Spey');
  });

  // FAILS - InvalidFieldNameException: no such column: version
  //
  //   update `dog` set `breed` = ?, `version` = ?
  //     where `id` = ? and `version` = ? returning `version`
  //
  // the version column exists only on `animal`, never on `dog`
  test('updating a child-owned column bumps the version on the declaring table', async () => {
    const dog = orm.em.create(Dog, { name: 'Rex', breed: 'poodle' });
    await orm.em.flush();
    orm.em.clear();

    const found = await orm.em.findOneOrFail(Dog, dog.id);
    found.breed = 'labrador';
    await orm.em.flush();
    orm.em.clear();

    const reloaded = await orm.em.findOneOrFail(Dog, dog.id);
    expect(reloaded.breed).toBe('labrador');
    expect(reloaded.version).toBe(2);
  });

  // FAILS - same exception via the batched update path
  //
  //   update `dog` set `breed` = case when (`id` = ?) then ? when (`id` = ?) then ? else `breed` end,
  //     `version` = `version` + 1 where `id` in (?, ?) returning `id`, `version`
  test('batched update of a child-owned column bumps the version on the declaring table', async () => {
    orm.em.create(Dog, { name: 'Rex', breed: 'poodle' });
    orm.em.create(Dog, { name: 'Fido', breed: 'poodle' });
    await orm.em.flush();
    orm.em.clear();

    const all = await orm.em.find(Dog, {});
    all.forEach(dog => (dog.breed = 'labrador'));
    await orm.em.flush();
    orm.em.clear();

    const reloaded = await orm.em.find(Dog, {}, { orderBy: { id: 'asc' } });
    expect(reloaded.map(dog => dog.breed)).toEqual(['labrador', 'labrador']);
    expect(reloaded.map(dog => dog.version)).toEqual([2, 2]);
  });

  // FAILS - TypeError: Cannot read properties of undefined (reading 'id')
  // thrown from ChangeSetPersister.checkOptimisticLocks; TPT parent change sets
  // are never assigned `originalEntity`. Independent of the above.
  test('batched update of a root-owned column bumps the version', async () => {
    orm.em.create(Dog, { name: 'Rex', breed: 'poodle' });
    orm.em.create(Dog, { name: 'Fido', breed: 'poodle' });
    await orm.em.flush();
    orm.em.clear();

    const all = await orm.em.find(Dog, {});
    all.forEach(dog => (dog.name = 'Rover'));
    await orm.em.flush();
    orm.em.clear();

    const reloaded = await orm.em.find(Dog, {}, { orderBy: { id: 'asc' } });
    expect(reloaded.map(dog => dog.version)).toEqual([2, 2]);
  });

  // FAILS - Error: Trying to query by not existing property Bird.version
  // checkOptimisticLocks queries `meta.root`, which for a hierarchy versioned below
  // the root is a table with no version column.
  test('batched update bumps the version when it is declared below the root', async () => {
    orm.em.create(Parrot, { name: 'Polly', wingspan: 30 });
    orm.em.create(Parrot, { name: 'Hector', wingspan: 32 });
    await orm.em.flush();
    orm.em.clear();

    const all = await orm.em.find(Parrot, {});
    all.forEach(parrot => (parrot.wingspan = 35));
    await orm.em.flush();
    orm.em.clear();

    const reloaded = await orm.em.find(Parrot, {}, { orderBy: { id: 'asc' } });
    expect(reloaded.map(parrot => parrot.version)).toEqual([2, 2]);
  });

  // FAILS on the assertion, with no exception raised - the quiet one.
  // Only `update `bird` set `name` = ? where `id` = ?` is emitted: no version bump and
  // no optimistic lock predicate anywhere, so the update silently escapes the lock and
  // a concurrent writer's change would be lost without any error.
  test('updating a root-owned column bumps the version when it is declared below the root', async () => {
    const parrot = orm.em.create(Parrot, { name: 'Polly', wingspan: 30 });
    await orm.em.flush();
    orm.em.clear();

    const found = await orm.em.findOneOrFail(Parrot, parrot.id);
    found.name = 'Hector';
    await orm.em.flush();
    orm.em.clear();

    const reloaded = await orm.em.findOneOrFail(Parrot, parrot.id);
    expect(reloaded.name).toBe('Hector');
    expect(reloaded.version).toBe(2);
  });
});
