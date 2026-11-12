typedef struct Person {
    int age;
    char* name;
} Person;

Person *get_persons(void) {
    Person* sharedPersons[1] = {{age:1,name: 'lb'}};
    return sharedPersons;
}