-- Synthetic SandboxVars written by Theriark for the Dialwarden demo server
-- and tests; the comments are our own words, not the game's.
SandboxVars = {
    VERSION = 6,
    -- Population preset; it also rewrites the multiplier below.
    Zombies = 4,
    -- Where the dead gather.
    Distribution = 1,
    -- Respawn preset for the undead.
    ZombieRespawn = 4,
    -- The horde drifts into cleared cells.
    ZombieMigrate = true,
    -- Real length of one game day.
    DayLength = 4,
    StartMonth = 7,
    StartTime = 2,
    -- Months since the outbreak at world start.
    TimeSinceApo = 1,
    WaterShut = 2,
    ElecShut = 2,
    -- Spawn weights, Build 42 numbers.
    FoodLootNew = 0.8,
    WeaponLootNew = 0.6,
    RangedWeaponLootNew = 1.2,
    AmmoLootNew = 0.6,
    MedicalLootNew = 0.6,
    SkillBookLoot = 0.6,
    OtherLootNew = 0.8,
    -- Loot-table rolls; high values hurt performance.
    RollsMultiplier = 1.0,
    LootItemRemovalList = "",
    HoursForLootRespawn = 0,
    MaxItemsForLootRespawn = 5,
    MaximumLooted = 25,
    -- Climate and survival.
    Temperature = 3,
    Rain = 3,
    ErosionSpeed = 4,
    StatsDecrease = 3,
    NatureAbundance = 3,
    FoodRotSpeed = 3,
    Nutrition = true,
    StarterKit = false,
    CharacterFreePoints = 0,
    HoursForCorpseRemoval = 216.0,
    Helicopter = 2,
    MetaEvent = 2,
    GeneratorSpawning = 4,
    Alarm = 4,
    LockedHouses = 6,
    HoursForWorldItemRemoval = 24.0,
    BloodSplatLifespanDays = 0,
    -- Vehicles.
    EnableVehicles = true,
    CarSpawnRate = 3,
    InitialGas = 2,
    LockedCar = 4,
    FuelStationGasInfinite = false,
    -- Build 42 systems.
    AnimalRanchChance = 5,
    MaximumRatIndex = 25,
    Basement = {
        -- How often random basements are placed.
        SpawnFrequency = 4,
    },
    Map = {
        -- A corner minimap for players.
        AllowMiniMap = false,
    },
    -- Zombie lore; Speed and Strength repeat as names in other tables.
    ZombieLore = {
        Speed = 4,
        SprinterPercentage = 0,
        Strength = 2,
        Toughness = 4,
        Transmission = 1,
        Mortality = 5,
        Reanimate = 3,
        Cognition = 3,
        Memory = 2,
        Sight = 5,
        Hearing = 5,
        ActiveOnly = 1,
        ThumpOnConstruction = true,
        DisableFakeDead = 1,
        FenceThumpersRequired = 25,
    },
    ZombieConfig = {
        PopulationMultiplier = 0.65,
        PopulationStartMultiplier = 1.0,
        PopulationPeakMultiplier = 1.5,
        PopulationPeakDay = 28,
        RespawnHours = 0.0,
        RespawnUnseenHours = 0.0,
        RespawnMultiplier = 0.0,
        ZombiesCountBeforeDelete = 300,
    },
    MultiplierConfig = {
        -- Global experience rate; the game allows far more than our cap.
        Global = 1.0,
        GlobalToggle = true,
        -- One of the per-skill rates; Strength repeats as a name in the
        -- zombie lore table above.
        Strength = 1.0,
    },
    -- Build 41 keys a Build 42 file may still hold; kept untouched.
    XpMultiplier = 1.0,
    FoodLoot = 4,
    LootRespawn = 1,
    -- A table a mod appended; unknown to the pack and kept as it is.
    SomeModOptions = {
        TweakLevel = 2,
    },
}
